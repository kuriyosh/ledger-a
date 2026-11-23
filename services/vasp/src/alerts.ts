import { setTimeout } from "node:timers/promises";
import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { signHttpRequest } from "@ledgera/shared/http-signature";
import { logService } from "@ledgera/shared/server";
import {
  type Address,
  bytesToHex,
  getAddress,
  type Hex,
  type LocalAccount,
  zeroAddress,
} from "viem";
import { z } from "zod";
import {
  type AmlSettings,
  amlFindings,
  type TokenSymbol,
} from "./aml-rules.ts";
import { type AlertStore, alertView } from "./db/alerts.ts";

const proposal = z.object({
  id: z.string().startsWith("p_"),
  type: z.literal("BLOCK_ACCOUNT"),
  safeNonce: z.string().regex(/^\d+$/).transform(BigInt),
  cancellation: z
    .object({ cancelSafeTxHash: z.string().nullable() })
    .nullable(),
  params: z.object({
    account: z.string(),
    reasonId: z.string(),
  }),
  requestedBy: z.object({ vaspId: z.number() }),
  withdrawalRequest: z
    .object({ requestedAt: z.string(), reason: z.string() })
    .nullable(),
  status: z.enum([
    "open",
    "executable",
    "failed",
    "cancelling",
    "cancelled",
    "executed",
  ]),
});
const proposalList = z.object({ proposals: z.array(z.unknown()) });
type Proposal = z.infer<typeof proposal>;
type Alert = Awaited<ReturnType<AlertStore["alert"]>>;
const now = () => Math.floor(Date.now() / 1_000);
const batchSize = 32;

function offline() {
  return new ServiceError(
    "CONSORTIUM_UNAVAILABLE",
    "Consortium response could not be verified",
    503,
  );
}

export function alertService(
  store: AlertStore,
  chain: {
    senderKind(from: Address, blockHash: Hex): Promise<number>;
    blocked(address: Address): Promise<boolean>;
    finalizedSafeNonce(): Promise<bigint>;
  },
  tokens: Record<TokenSymbol, Address>,
  config: {
    ownId: number;
    signer: LocalAccount;
    url?: string;
    rules: AmlSettings;
  },
  exclusive: Awaited<ReturnType<typeof openDatabase>>["exclusive"],
  requestHttp = fetch,
) {
  let candidateCursor: string | undefined;
  let proposalCursor: string | undefined;
  const inFlight = new Map<string, Promise<Alert>>();

  async function request(path: string, body?: object, timestamp?: number) {
    if (!config.url) throw offline();
    const request = new Request(new URL(path, config.url), {
      method: body ? "POST" : "GET",
      body: body && JSON.stringify(body),
      headers: body ? { "Content-Type": "application/json" } : {},
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (body) {
      const headers = await signHttpRequest(
        config.signer,
        request,
        config.ownId,
        timestamp,
      );
      for (const [key, value] of Object.entries(headers))
        request.headers.set(key, value);
    }
    const response = await requestHttp(request).catch(() => {
      throw offline();
    });
    return {
      status: response.status,
      value: (await response.json().catch(() => undefined)) as unknown,
    };
  }

  function linked(raw: unknown, alert: Alert): Proposal | undefined {
    const parsed = proposal.safeParse(raw);
    if (!parsed.success || !alert.reasonId) return;
    const record = parsed.data;
    return record.requestedBy.vaspId === config.ownId &&
      record.params.reasonId.toLowerCase() === bytesToHex(alert.reasonId) &&
      record.params.account.toLowerCase() === bytesToHex(alert.address)
      ? record
      : undefined;
  }

  async function recover(alert: Alert) {
    const response = await request("/v1/proposals");
    if (response.status !== 200) throw offline();
    const records = proposalList.safeParse(response.value);
    if (!records.success) throw offline();
    for (const item of records.data.proposals) {
      const match = linked(item, alert);
      if (match) return match;
    }
  }

  async function connect(alert: Alert) {
    if (!alert.reasonId || alert.requestTimestamp === null || alert.proposalId)
      return alert;
    const prior = await recover(alert);
    if (prior) return store.attach(alert.id, prior.id);
    if (alert.status !== "open") return alert;

    if (now() - alert.requestTimestamp >= 240) {
      const updated = await store.changeTimestamp(alert, now());
      if (!updated) return store.alert(alert.id);
      alert = updated;
    }
    const current = await store.alert(alert.id);
    if (
      current.status !== "open" ||
      current.proposalId ||
      !current.reasonId ||
      current.requestTimestamp === null
    )
      return current;
    const result = await request(
      "/v1/proposals",
      {
        type: "BLOCK_ACCOUNT",
        params: {
          account: getAddress(bytesToHex(current.address)),
          reasonId: bytesToHex(current.reasonId),
        },
        reason: `AML ${current.rule}`,
        requestedBy: { vaspId: config.ownId },
      },
      current.requestTimestamp,
    );
    if (result.status === 409) {
      const prior = await recover(current);
      if (prior) return store.attach(current.id, prior.id);
      throw new ServiceError(
        "PROPOSAL_IN_PROGRESS",
        "Consortium already has a pending proposal",
        409,
      );
    }
    const created = result.status === 201 && linked(result.value, current);
    if (!created) throw offline();
    return store.attach(current.id, created.id);
  }

  function synchronize(row: Alert) {
    const existing = inFlight.get(row.id);
    if (existing) return existing;
    const next = connect(row).finally(() => inFlight.delete(row.id));
    inFlight.set(row.id, next);
    return next;
  }

  async function advance(row: Alert) {
    if (!row.proposalId) row = await synchronize(row);
    if (!row.proposalId) return;
    const path = `/v1/proposals/${encodeURIComponent(row.proposalId)}`;
    const response = await request(path);
    const current = response.status === 200 && linked(response.value, row);
    if (!current) throw offline();

    if (
      row.status !== "frozen" &&
      current.status === "executed" &&
      !(await chain.blocked(getAddress(bytesToHex(row.address))))
    )
      throw offline();
    if (row.status === "invalidated") {
      if (current.status === "executed") {
        await store.status(row, "frozen", true);
      } else if (current.status === "cancelled") {
        if (
          current.cancellation?.cancelSafeTxHash === null ||
          (await chain.finalizedSafeNonce()) > current.safeNonce
        )
          await store.settled(row.id);
      } else if (current.withdrawalRequest && !row.withdrawalSentAt) {
        await store.withdrawn(row.id);
      } else if (!row.withdrawalSentAt) {
        const result = await request(`${path}/withdrawal-request`, {
          reason: "The supporting deposit left the canonical chain",
        });
        if (
          result.status === 200 &&
          linked(result.value, row)?.withdrawalRequest
        )
          await store.withdrawn(row.id);
      }
      return;
    }
    if (current.status === "executed") {
      await store.status(row, "frozen", row.evidenceReorged);
    } else if (current.status === "cancelled") {
      await store.status(row, "closed", row.evidenceReorged);
    } else if (row.status === "frozen") {
      await store.status(
        row,
        row.evidenceReorged ? "invalidated" : "freeze_requested",
        row.evidenceReorged,
      );
    }
  }

  async function evaluate(signal: AbortSignal) {
    const candidates = await store.candidates(candidateCursor, batchSize);
    candidateCursor =
      candidates.length === batchSize ? candidates.at(-1)?.id : undefined;
    for (const entry of candidates) {
      signal.throwIfAborted();
      try {
        const token = bytesToHex(entry.token).toLowerCase();
        const symbol = (Object.keys(tokens) as TokenSymbol[]).find(
          (key) => tokens[key].toLowerCase() === token,
        );
        if (!symbol || !entry.blockHash)
          throw new Error("Unknown incoming token or block");
        const sender = getAddress(bytesToHex(entry.from));
        const senderKind =
          sender === zeroAddress
            ? 0
            : await chain.senderKind(sender, bytesToHex(entry.blockHash));
        await store.evaluated(
          entry,
          symbol,
          amlFindings({ ...entry, senderKind, token: symbol }, config.rules),
        );
      } catch (error) {
        logService("vasp", "error", "AML evaluation did not advance", null, {
          id: entry.id,
          errorName: error instanceof Error ? error.name : "Error",
        });
      }
    }
  }

  async function scanProposals(signal: AbortSignal) {
    if (!config.url) return;
    const items = await store.watched(proposalCursor, batchSize);
    proposalCursor = items.length === batchSize ? items.at(-1)?.id : undefined;
    for (const row of items) {
      signal.throwIfAborted();
      try {
        await advance(row);
      } catch (error) {
        logService("vasp", "error", "Freeze proposal did not advance", null, {
          id: row.id,
          code:
            error instanceof ServiceError
              ? error.code
              : "CONSORTIUM_UNAVAILABLE",
        });
      }
    }
  }

  return {
    list: (limit: number) => store.list(limit),
    close: (id: string) => store.close(id),
    async freeze(id: string) {
      if (!config.url) throw offline();
      const row = await store.prepare(id, now());
      return alertView(await synchronize(row));
    },
    async poll(signal: AbortSignal) {
      while (!signal.aborted) {
        try {
          await exclusive("aml-alerts", async () => {
            await evaluate(signal);
            await scanProposals(signal);
          });
        } catch (error) {
          if (!signal.aborted)
            logService("vasp", "error", "AML polling did not advance", null, {
              errorName: error instanceof Error ? error.name : "Error",
            });
        }
        await setTimeout(5_000, undefined, { signal }).catch(() => {});
      }
    },
  };
}
