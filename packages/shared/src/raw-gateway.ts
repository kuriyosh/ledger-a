import type { Hex } from "viem";
import { z } from "zod";
import { ServiceError } from "./errors.ts";

export type RawGatewayRequest = { txHash: Hex; rawTx: Hex };

const hexHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
const gatewayReceipt = z.object({
  seq: z.string().regex(/^\d{1,20}$/),
  txHash: hexHash,
});
const gatewayReply = z.union([
  z.object({ result: z.object({ txHash: hexHash, receipt: gatewayReceipt }) }),
  z.object({
    error: z.object({
      data: z
        .object({
          reason: z.string().optional(),
          receipt: gatewayReceipt.optional(),
        })
        .optional(),
    }),
  }),
]);
const definiteRejection = new Set([
  "INVALID_TX",
  "UNSUPPORTED_TX_TYPE",
  "WRONG_CHAIN_ID",
  "PRIORITY_FEE_NOT_FIXED",
  "MAX_FEE_TOO_LOW",
  "GAS_LIMIT_TOO_HIGH",
  "NONCE_GAP",
  "INSUFFICIENT_FUNDS",
  "SENDER_NOT_ALLOWED",
  "FORWARD_REJECTED",
]);

function gatewayUnavailable() {
  return new ServiceError(
    "GATEWAY_UNAVAILABLE",
    "Gateway could not confirm the transaction",
    503,
  );
}

export function rawGateway(gatewayUrl: string, requestHttp = fetch) {
  async function request(
    path: string,
    init?: RequestInit,
    allowMissing = false,
  ) {
    try {
      const result = await requestHttp(new URL(path, gatewayUrl), {
        ...init,
        signal: AbortSignal.timeout(18_000),
      });
      if (allowMissing && result.status === 404) return undefined;
      if (!result.ok) throw gatewayUnavailable();
      return await result.json();
    } catch {
      throw gatewayUnavailable();
    }
  }
  async function statusOf(hash: Hex) {
    const body = await request(`/v1/receipts/${hash}`, undefined, true);
    if (body === undefined) return "missing" as const;
    const stored = gatewayReceipt.safeParse(body);
    if (!stored.success || stored.data.txHash !== hash)
      throw gatewayUnavailable();
    const log = z
      .object({
        entries: z.array(
          z.object({ txHash: hexHash, forwardStatus: z.string() }),
        ),
      })
      .safeParse(await request(`/v1/log?fromSeq=${stored.data.seq}&limit=1`));
    const match = log.success && log.data.entries[0];
    if (!match || match.txHash !== hash) throw gatewayUnavailable();
    return match.forwardStatus === "rejected"
      ? ("rejected" as const)
      : ("accepted" as const);
  }

  return {
    async submit(
      pending: RawGatewayRequest,
    ): Promise<"accepted" | "rejected" | "nonce_used"> {
      const response = gatewayReply.safeParse(
        await request("/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: pending.txHash,
            method: "ledgera_sendRawTransaction",
            params: [pending.rawTx],
          }),
        }),
      );
      if (!response.success) throw gatewayUnavailable();
      if ("result" in response.data) {
        if (
          response.data.result.txHash !== pending.txHash ||
          response.data.result.receipt.txHash !== pending.txHash
        ) {
          throw gatewayUnavailable();
        }
        return "accepted";
      }
      const detail = response.data.error.data;
      const reason = detail?.reason;
      if (
        detail?.receipt?.txHash === pending.txHash &&
        reason !== "FORWARD_REJECTED"
      )
        return "accepted";
      if (reason === "NONCE_TOO_LOW") return "nonce_used";
      if (
        reason === "DUPLICATE_TX" ||
        (reason && definiteRejection.has(reason))
      ) {
        const recorded = await statusOf(pending.txHash);
        if (recorded !== "missing") return recorded;
        if (reason !== "DUPLICATE_TX" && reason !== "FORWARD_REJECTED")
          return "rejected";
      }
      throw gatewayUnavailable();
    },
  };
}
