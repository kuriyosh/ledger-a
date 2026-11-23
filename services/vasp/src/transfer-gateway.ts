import { ledgerForwarderAbi } from "@ledgera/abis";
import { ServiceError } from "@ledgera/shared/errors";
import {
  type Address,
  decodeFunctionData,
  type Hex,
  keccak256,
  parseTransaction,
  type TransactionSerialized,
} from "viem";
import { z } from "zod";
import type { ForwardPayload } from "./db/transfers.ts";

const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
const seq = z
  .string()
  .regex(/^[0-9]{1,19}$/)
  .transform(BigInt);
const receipt = z.object({ seq, txHash: hash });
const log = z.object({
  entries: z
    .array(
      z.object({
        seq,
        txHash: hash,
        rawTx: z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/),
        forwardStatus: z.enum(["queued", "forwarded", "rejected", "held_demo"]),
        source: z.string(),
      }),
    )
    .max(1000),
});
const errors = z.object({
  error: z.object({
    code: z.string(),
    details: z
      .object({ receipt: receipt.optional(), errorName: z.string().optional() })
      .optional(),
  }),
});

type Accepted = {
  status: "accepted";
  txHash: Hex;
  seq: bigint;
  simulationError?: string;
};
type Rejected = {
  status: "rejected";
  code: string;
  receipt?: z.infer<typeof receipt>;
};
type RelayResult = Accepted | Rejected | { status: "unavailable" };

export function matchesForwardCall(data: Hex, request: ForwardPayload) {
  try {
    const decoded = decodeFunctionData({ abi: ledgerForwarderAbi, data });
    if (
      decoded.functionName !== "execute" &&
      decoded.functionName !== "executeAll"
    )
      return false;
    const operations =
      decoded.functionName === "execute" ? [decoded.args[0]] : decoded.args[0];
    return operations.some(
      (operation) =>
        operation.from.toLowerCase() === request.from.toLowerCase() &&
        operation.to.toLowerCase() === request.to.toLowerCase() &&
        operation.signature.toLowerCase() === request.signature.toLowerCase() &&
        operation.data.toLowerCase() === request.data.toLowerCase() &&
        operation.value === BigInt(request.value) &&
        operation.gas === BigInt(request.gas) &&
        operation.deadline === request.deadline,
    );
  } catch {
    return false;
  }
}

function matches(
  raw: string,
  hash: Hex,
  forwarder: Address,
  request: ForwardPayload,
) {
  try {
    const serialized = raw as TransactionSerialized;
    const signed = parseTransaction(serialized);
    if (
      signed.to?.toLowerCase() !== forwarder.toLowerCase() ||
      signed.data === undefined ||
      !matchesForwardCall(signed.data, request)
    )
      return false;
    if (keccak256(serialized) !== hash)
      throw new ServiceError(
        "GATEWAY_LOG_INVALID",
        "Gateway transaction hash differs from its raw transaction",
        503,
      );
    return true;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    return false;
  }
}

export function transferGateway(
  url: string,
  token: string,
  forwarder: Address,
  requestHttp = fetch,
) {
  async function request(path: string, init?: RequestInit) {
    const response = await requestHttp(new URL(path, url), {
      ...init,
      signal: AbortSignal.timeout(18_000),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  }

  async function head() {
    const result = await request("/v1/log/head");
    return z.object({ seq }).parse(result.body).seq;
  }

  return {
    head,
    async forward(
      payload: ForwardPayload,
      submitOnRevert: boolean,
    ): Promise<RelayResult> {
      try {
        const response = await request("/relay/v1/forward", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ requests: [payload], submitOnRevert }),
        });
        if (response.status === 200) {
          const result = z
            .object({
              txHash: hash,
              receipt,
              simulation: z.object({
                reverted: z.boolean(),
                errorName: z.string().optional(),
              }),
            })
            .safeParse(response.body);
          if (
            !result.success ||
            result.data.txHash !== result.data.receipt.txHash
          )
            return { status: "unavailable" };
          return {
            status: "accepted",
            ...result.data.receipt,
            simulationError: result.data.simulation.reverted
              ? (result.data.simulation.errorName ?? "REVERTED")
              : undefined,
          };
        }
        const failure = errors.safeParse(response.body);
        if (!failure.success) return { status: "unavailable" };
        const { code, details } = failure.data.error;
        if (code === "FORWARD_REJECTED" && details?.receipt)
          return { status: "rejected", code, receipt: details.receipt };
        if (details?.receipt) return { status: "accepted", ...details.receipt };
        if (
          response.status >= 500 ||
          response.status === 401 ||
          response.status === 403 ||
          response.status === 429 ||
          code === "FORWARD_REJECTED" ||
          code === "DUPLICATE_TX"
        )
          return { status: "unavailable" };
        return {
          status: "rejected",
          code:
            code === "SIMULATION_REVERTED"
              ? (details?.errorName ?? "REVERTED")
              : code,
        };
      } catch {
        return { status: "unavailable" };
      }
    },
    async find(
      payload: ForwardPayload,
      from: bigint,
    ): Promise<Accepted | Rejected | undefined> {
      const through = await head();
      let cursor = from;
      let best: Accepted | Rejected | undefined;
      while (cursor <= through) {
        const result = await request(`/v1/log?fromSeq=${cursor}&limit=1000`);
        const page = log.parse(result.body).entries;
        if (!page.length)
          throw new ServiceError(
            "GATEWAY_LOG_INVALID",
            "Gateway log is incomplete",
            503,
          );
        for (const entry of page) {
          if (entry.seq !== cursor)
            throw new ServiceError(
              "GATEWAY_LOG_INVALID",
              "Gateway log has a sequence gap",
              503,
            );
          cursor = entry.seq + 1n;
          if (entry.seq > through) return best;
          if (
            entry.source !== "relay" ||
            !matches(entry.rawTx, entry.txHash, forwarder, payload)
          )
            continue;
          const receipt = { txHash: entry.txHash, seq: entry.seq };
          if (entry.forwardStatus === "forwarded")
            return { status: "accepted", ...receipt };
          if (entry.forwardStatus !== "rejected")
            best = { status: "accepted", ...receipt };
          else if (!best)
            best = { status: "rejected", code: "FORWARD_REJECTED", receipt };
        }
      }
      return best;
    },
  };
}
