import { setTimeout } from "node:timers/promises";
import { ServiceError } from "@ledgera/shared/errors";
import type { rawGateway } from "@ledgera/shared/raw-gateway";
import { logService } from "@ledgera/shared/server";
import type { Address, Hex } from "viem";
import type {
  ConsortiumRows,
  ConsortiumStore,
  PendingAction,
  ProposalStatus,
  RequestedBy,
  StoredProposal,
} from "./db/store.ts";
import { type ProposalInput, proposalCall } from "./proposals.ts";
import type { consortiumChain, Member, MemberId } from "./safe.ts";

type Chain = ReturnType<typeof consortiumChain>;
const notExecutable = () =>
  new ServiceError("NOT_EXECUTABLE", "Proposal cannot be executed now", 409);
const pending = (request: PendingAction) =>
  new ServiceError(
    "SAFE_ACTION_PENDING",
    "Safe action is awaiting inclusion",
    503,
    {
      txHash: request.txHash,
    },
  );

export function consortiumService(
  store: ConsortiumStore,
  chain: Chain,
  gateway: ReturnType<typeof rawGateway>,
  registry: Address,
  members: readonly Member[],
) {
  const inFlight = new Map<Hex, Promise<boolean>>();

  function member(id: MemberId) {
    const match = members.find((item) => item.id === id);
    if (!match)
      throw new ServiceError("MEMBER_NOT_FOUND", "Unknown member", 404);
    return match;
  }

  async function project(
    rows: ConsortiumRows,
    row: StoredProposal,
    failure?: Hex,
  ) {
    const evidence = await chain.observe(
      row.safeTxHash,
      row.safeNonce,
      row.firstBlock,
    );
    let status: ProposalStatus = "open";
    let failedTxHash: Hex | undefined;
    if (evidence.executed) {
      status = "executed";
    } else if (
      evidence.nonce === row.safeNonce &&
      evidence.approvals.length >= evidence.threshold
    ) {
      const possibleFailure = failure ?? row.failedTxHash;
      if (
        possibleFailure &&
        (await chain.receipt(possibleFailure))?.status === "reverted"
      ) {
        status = "failed";
        failedTxHash = possibleFailure;
      } else {
        status = "executable";
      }
    }
    const executionFinalized =
      evidence.executed !== undefined &&
      (await chain.executionIsFinal(evidence.executed));
    await rows.record(row.id, {
      ...evidence,
      status,
      failedTxHash,
      executionFinalized,
    });
    return { ...evidence, status };
  }

  async function refresh(rows: ConsortiumRows) {
    const ids = await rows.watched();
    for (const id of ids) await project(rows, await rows.proposal(id));
    return ids;
  }

  async function view(
    rows: ConsortiumRows,
    row: StoredProposal,
    threshold: number,
  ) {
    const { firstBlock, executedBlock, failedTxHash, ...display } = row;
    return {
      ...display,
      safeNonce: row.safeNonce.toString(),
      threshold,
      approvals: (await rows.approvals(row.id)).map((approval) => ({
        ...approval,
        blockNumber: approval.blockNumber.toString(),
      })),
      cancellation: null,
      withdrawalRequest: null,
    };
  }

  async function reconcile(request: PendingAction) {
    const owner = member(request.memberId);
    let receipt = await chain.receipt(request.txHash);
    if (!receipt) {
      const sent = await gateway.submit(request);
      if (sent === "accepted") {
        try {
          receipt = await chain.wait(request.txHash);
        } catch {
          receipt = await chain.receipt(request.txHash);
        }
      } else {
        receipt = await chain.receipt(request.txHash);
      }
      if (
        !receipt &&
        sent !== "rejected" &&
        !(await chain.replaced(owner, request))
      )
        throw pending(request);
    }
    const failure =
      receipt?.status === "reverted" && request.action === "execute"
        ? request.txHash
        : undefined;
    return store.lock(async (rows) => {
      const active = await rows.pending(request.proposalId);
      if (active?.txHash !== request.txHash)
        return receipt?.status === "success";
      const projected = await project(
        rows,
        await rows.proposal(request.proposalId),
        failure,
      );
      const confirmed =
        request.action === "approve"
          ? projected.approvals.some(
              (approval) => approval.memberId === request.memberId,
            )
          : projected.executed !== undefined;
      if (receipt?.status === "success" && !confirmed) throw pending(request);
      await rows.consume(request);
      return confirmed || failure !== undefined;
    });
  }

  function deliver(request: PendingAction) {
    const running = inFlight.get(request.txHash);
    if (running) return running;
    const result = reconcile(request).finally(() =>
      inFlight.delete(request.txHash),
    );
    inFlight.set(request.txHash, result);
    return result;
  }

  async function mutate(
    id: string,
    memberId: MemberId,
    action: PendingAction["action"],
  ) {
    const owner = member(memberId);
    const request = await store.lock(async (rows) => {
      const row = await rows.proposal(id);
      const current = await project(rows, row);
      const retained = await rows.pending(id);
      if (retained) {
        if (retained.memberId === memberId && retained.action === action)
          return retained;
        throw new ServiceError(
          "SAFE_ACTION_IN_PROGRESS",
          "Another Safe action is awaiting inclusion",
          409,
        );
      }
      if (current.nonce !== row.safeNonce || current.status === "executed")
        throw notExecutable();
      if (
        action === "approve" &&
        current.approvals.some((approval) => approval.memberId === memberId)
      )
        throw new ServiceError(
          "ALREADY_APPROVED",
          "Member already approved",
          409,
        );
      if (
        action === "execute" &&
        current.status !== "executable" &&
        current.status !== "failed"
      )
        throw notExecutable();
      const signed =
        action === "approve"
          ? await chain.approve(owner, row.safeTxHash)
          : await chain.execute(
              owner,
              row,
              current.approvals.map(({ address }) => address),
            );
      const next = { ...signed, proposalId: id, memberId, action };
      await rows.prepare(next);
      return next;
    });
    if (!(await deliver(request)))
      throw new ServiceError(
        "SAFE_ACTION_REJECTED",
        "Safe action was rejected",
        422,
        { txHash: request.txHash },
      );
    return get(id);
  }

  async function get(id: string) {
    const { threshold } = await chain.overview();
    return store.lock(async (rows) =>
      view(rows, await rows.proposal(id), threshold),
    );
  }

  return {
    get,
    async create(
      input: ProposalInput,
      requestedBy: RequestedBy,
      requestDigest?: Hex,
    ) {
      const target = proposalCall(registry, input);
      const { threshold } = await chain.overview();
      return store.lock(async (rows) => {
        await refresh(rows);
        const prior =
          requestDigest && (await rows.byRequestDigest(requestDigest));
        const row =
          prior ||
          (await rows.create(
            input,
            requestedBy,
            target,
            requestDigest,
            await chain.identify(target),
          ));
        return view(rows, row, threshold);
      });
    },
    async list(status?: ProposalStatus) {
      const { threshold } = await chain.overview();
      return store.lock(async (rows) =>
        Promise.all(
          (await rows.listing(status)).map((row) => view(rows, row, threshold)),
        ),
      );
    },
    approve: (id: string, memberId: MemberId) =>
      mutate(id, memberId, "approve"),
    execute: (id: string, memberId: MemberId) =>
      mutate(id, memberId, "execute"),
    async poll(signal: AbortSignal) {
      while (!signal.aborted) {
        try {
          const ids = await store.lock(refresh);
          for (const id of ids) {
            signal.throwIfAborted();
            const request = await store.pending(id);
            if (request) await deliver(request);
          }
        } catch (error) {
          if (!signal.aborted)
            logService(
              "consortium",
              "error",
              "Safe reconciliation did not advance",
              null,
              {
                ...(error instanceof ServiceError ? error.details : {}),
                code:
                  error instanceof ServiceError ? error.code : "INTERNAL_ERROR",
              },
            );
        }
        await setTimeout(10_000, undefined, { signal }).catch(() => {});
      }
    },
  };
}
