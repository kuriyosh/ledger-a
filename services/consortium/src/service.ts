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
  const cancelCall = { to: chain.address, data: "0x" } as const;

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
      {
        approvals: await rows.approvals(row.id),
        executedTxHash: row.executedTxHash,
      },
    );
    const cancellation = row.cancelSafeTxHash
      ? await chain.observe(
          row.cancelSafeTxHash,
          row.safeNonce,
          row.firstBlock,
          {
            approvals: await rows.approvals(row.id, "cancel"),
            executedTxHash: row.cancelExecutedTxHash,
          },
        )
      : undefined;
    let status: ProposalStatus = "open";
    let failedTxHash: Hex | undefined;
    if (row.cancelledLocally) {
      return { ...evidence, cancellation, status: "cancelled" as const };
    }
    if (evidence.executed) {
      status = "executed";
    } else if (cancellation?.executed) {
      status = "cancelled";
    } else if (cancellation) {
      status = "cancelling";
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
    const finished = evidence.executed ?? cancellation?.executed;
    const superseded =
      !finished &&
      evidence.nonce > row.safeNonce &&
      (await chain.finalizedNonce()) > row.safeNonce;
    if (superseded) status = "cancelled";
    await rows.record(row.id, {
      ...evidence,
      status,
      failedTxHash,
      cancelApprovals: cancellation?.approvals,
      cancelled: cancellation?.executed,
      executionFinalized:
        superseded ||
        (finished !== undefined && (await chain.executionIsFinal(finished))),
    });
    return { ...evidence, cancellation, status };
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
    const {
      firstBlock,
      executedBlock,
      failedTxHash,
      cancelSafeTxHash,
      cancelExecutedTxHash,
      cancelExecutedBlock,
      cancelExecutionPrepared,
      cancelledLocally,
      withdrawalRequestedAt,
      withdrawalReason,
      ...display
    } = row;
    async function approvalList(kind: "execute" | "cancel") {
      return (await rows.approvals(row.id, kind)).map((approval) => ({
        ...approval,
        blockNumber: approval.blockNumber.toString(),
      }));
    }
    return {
      ...display,
      safeNonce: row.safeNonce.toString(),
      threshold,
      approvals: await approvalList("execute"),
      cancellation:
        cancelSafeTxHash || cancelledLocally
          ? {
              cancelSafeTxHash,
              approvals: await approvalList("cancel"),
              executedTxHash: cancelExecutedTxHash,
            }
          : null,
      withdrawalRequest: withdrawalRequestedAt
        ? { requestedAt: withdrawalRequestedAt, reason: withdrawalReason }
        : null,
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
      const approved = (kind: "execute" | "cancel") =>
        (kind === "execute"
          ? projected.approvals
          : projected.cancellation?.approvals
        )?.some((approval) => approval.memberId === request.memberId) ?? false;
      const confirmed = {
        approve: approved("execute"),
        execute: projected.executed !== undefined,
        cancel_approve: approved("cancel"),
        cancel_execute: projected.cancellation?.executed !== undefined,
      }[request.action];
      if (
        receipt?.status === "success" &&
        !confirmed &&
        projected.status !== "executed" &&
        projected.status !== "cancelled"
      )
        throw pending(request);
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
    requested: "approve" | "execute" | "cancel" | "cancel_execute",
  ) {
    const owner = member(memberId);
    const request = await store.lock(async (rows) => {
      let row = await rows.proposal(id);
      let state = await project(rows, row);
      const cancellation =
        requested === "cancel" || requested === "cancel_execute";
      if (state.status === "executed" || state.status === "cancelled") {
        if (cancellation) return undefined;
        throw notExecutable();
      }
      if (state.nonce !== row.safeNonce) throw notExecutable();
      const retained = await rows.pending(id);
      if (retained) {
        const same =
          retained.action === requested ||
          (requested === "cancel" && retained.action.startsWith("cancel_"));
        if (retained.memberId === memberId && same) return retained;
        throw new ServiceError(
          "SAFE_ACTION_IN_PROGRESS",
          "Another Safe action is awaiting inclusion",
          409,
        );
      }
      if (!cancellation && state.status === "cancelling")
        throw new ServiceError(
          "CANCELLING",
          "Proposal cancellation is in progress",
          409,
        );
      if (requested === "execute" && row.withdrawalRequestedAt)
        throw new ServiceError(
          "WITHDRAWAL_REQUESTED",
          "The requesting VASP withdrew its proposal",
          409,
        );

      let action: PendingAction["action"];
      let approvals = state.approvals;
      let hash = row.safeTxHash;
      let call = { to: row.to, data: row.data };
      if (cancellation) {
        if (!row.cancelSafeTxHash) {
          if (requested === "cancel_execute") throw notExecutable();
          if (state.approvals.length === 0) {
            await rows.requestCancellation(id);
            return undefined;
          }
          const target = await chain.identify(cancelCall);
          if (target.safeNonce !== row.safeNonce) throw notExecutable();
          await rows.requestCancellation(id, target.safeTxHash);
          row = await rows.proposal(id);
          state = await project(rows, row);
          if (state.status === "executed" || state.status === "cancelled")
            return undefined;
        }
        if (
          !row.cancelSafeTxHash ||
          !state.cancellation ||
          state.cancellation.nonce !== row.safeNonce
        )
          throw notExecutable();
        approvals = state.cancellation.approvals;
        hash = row.cancelSafeTxHash;
        call = cancelCall;
        const quorum = approvals.length >= state.cancellation.threshold;
        if (requested === "cancel_execute" && !quorum) throw notExecutable();
        action = quorum ? "cancel_execute" : "cancel_approve";
      } else {
        action = requested;
        if (
          action === "execute" &&
          state.status !== "executable" &&
          state.status !== "failed"
        )
          throw notExecutable();
      }
      const approving = action === "approve" || action === "cancel_approve";
      if (
        approving &&
        approvals.some((approval) => approval.memberId === memberId)
      )
        throw new ServiceError(
          "ALREADY_APPROVED",
          "Member already approved",
          409,
        );
      const signed = approving
        ? await chain.approve(owner, hash)
        : await chain.execute(
            owner,
            call,
            approvals.map(({ address }) => address),
          );
      const next = { ...signed, proposalId: id, memberId, action };
      await rows.prepare(next);
      if (action === "cancel_execute") await rows.cancellationPrepared(id);
      return next;
    });

    if (request && !(await deliver(request)))
      throw new ServiceError(
        "SAFE_ACTION_REJECTED",
        "Safe action was rejected",
        422,
        { txHash: request.txHash },
      );
    return get(id);
  }

  async function cancel(id: string, memberId: MemberId) {
    const updated = await mutate(id, memberId, "cancel");
    if (
      updated.status === "cancelling" &&
      updated.cancellation &&
      updated.cancellation.approvals.length >= updated.threshold
    )
      return mutate(id, memberId, "cancel_execute");
    return updated;
  }

  async function continueCancellation(id: string) {
    const row = await store.proposal(id);
    if (row.status !== "cancelling" || row.cancelExecutionPrepared) return;
    const projection = await get(id);
    const recorded = projection.cancellation?.approvals;
    if (!recorded || recorded.length < projection.threshold) return;
    const last = recorded.reduce((a, b) =>
      BigInt(a.blockNumber) > BigInt(b.blockNumber) ? a : b,
    );
    await mutate(id, last.memberId, "cancel_execute");
  }

  async function get(id: string) {
    const { threshold } = await chain.overview();
    return store.read(async (rows) =>
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
      return store.read(async (rows) =>
        Promise.all(
          (await rows.listing(status)).map((row) => view(rows, row, threshold)),
        ),
      );
    },
    approve: (id: string, memberId: MemberId) =>
      mutate(id, memberId, "approve"),
    execute: (id: string, memberId: MemberId) =>
      mutate(id, memberId, "execute"),
    cancel,
    async withdraw(id: string, vaspId: number, reason: string) {
      await store.lock(async (rows) => {
        const row = await rows.proposal(id);
        if (!("vaspId" in row.requestedBy) || row.requestedBy.vaspId !== vaspId)
          throw new ServiceError(
            "PROPOSAL_NOT_FOUND",
            "Proposal does not exist",
            404,
          );
        const current = await project(rows, row);
        if (current.status === "executed" || current.status === "cancelled")
          throw new ServiceError(
            "PROPOSAL_TERMINAL",
            "Proposal is already closed",
            409,
          );
        await rows.withdraw(id, reason);
      });
      return get(id);
    },
    async poll(signal: AbortSignal) {
      while (!signal.aborted) {
        try {
          const ids = await store.lock(refresh);
          for (const id of ids) {
            signal.throwIfAborted();
            const request = await store.pending(id);
            if (request) await deliver(request);
            await continueCancellation(id);
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
