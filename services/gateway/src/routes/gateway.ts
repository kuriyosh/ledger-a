import { ServiceError } from "@ledgera/shared/errors";
import { logService, serviceApp } from "@ledgera/shared/server";
import { type Hex, numberToHex } from "viem";
import { z } from "zod";
import type { ForwardNotifications } from "../chain/forwarder.ts";
import { type GatewayStore, receiptJson } from "../db/store.ts";
import {
  AdmissionError,
  type createAdmission,
  type SignedReceipt,
} from "../domain/admission.ts";

const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string(),
  params: z.array(z.unknown()).default([]),
});
const hash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .transform((value) => value as Hex);
const logQuery = z.object({
  fromSeq: z
    .string()
    .regex(/^\d{1,19}$/)
    .transform(BigInt)
    .refine((value) => value <= 9_223_372_036_854_775_807n)
    .default(1n),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const receiptLookup = z.object({ txHashes: z.array(hash).min(1).max(200) });

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
) {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

type Options = {
  chainId: number;
  genesisHash: Hex;
  store: GatewayStore;
  accept: ReturnType<typeof createAdmission>;
  signal: AbortSignal;
  notifications: ForwardNotifications;
};

export async function waitForForwarding(
  store: GatewayStore,
  receipt: SignedReceipt,
  notifications: ForwardNotifications,
  signal: AbortSignal,
) {
  const next = await notifications.wait(
    store,
    receipt.seq,
    AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  );
  if (next?.status === "forwarded") return;
  const details = { receipt: receiptJson(receipt) };
  if (next?.status === "rejected") {
    throw new AdmissionError(
      "FORWARD_REJECTED",
      next.error?.replace(/^ledgera: /, "") ??
        "sequencer rejected the transaction",
      details,
    );
  }
  throw new AdmissionError(
    "SEQUENCER_UNAVAILABLE",
    "forwarding is still pending",
    details,
  );
}

export function gatewayApp({
  chainId,
  genesisHash,
  store,
  accept,
  signal,
  notifications,
}: Options) {
  const app = serviceApp("gateway");

  app.post("/rpc", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(rpcError(null, -32700, "ledgera: invalid JSON"));
    }
    const request = rpcRequest.safeParse(body);
    if (!request.success) {
      return context.json(
        rpcError(null, -32600, "ledgera: invalid JSON-RPC request"),
      );
    }
    const { id, method, params } = request.data;
    if (method === "eth_chainId") {
      return context.json({ jsonrpc: "2.0", id, result: numberToHex(chainId) });
    }
    if (
      method !== "eth_sendRawTransaction" &&
      method !== "ledgera_sendRawTransaction"
    ) {
      return context.json(rpcError(id, -32601, "ledgera: method not found"));
    }
    if (params.length !== 1) {
      return context.json(
        rpcError(id, -32602, "ledgera: expected one signed transaction"),
      );
    }

    try {
      if (signal.aborted)
        throw new AdmissionError(
          "SEQUENCER_UNAVAILABLE",
          "gateway is stopping",
        );
      const receipt = await accept(params[0]);
      await waitForForwarding(
        store,
        receipt,
        notifications,
        AbortSignal.any([signal, context.req.raw.signal]),
      );
      const result =
        method === "eth_sendRawTransaction"
          ? receipt.txHash
          : { txHash: receipt.txHash, receipt: receiptJson(receipt) };
      return context.json({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error instanceof AdmissionError) {
        return context.json(
          rpcError(id, -32000, error.message, {
            reason: error.code,
            ...error.details,
          }),
        );
      }
      logService(
        "gateway",
        "error",
        "Transaction admission or forwarding failed",
        context.get("traceId"),
        {
          errorName: error instanceof Error ? error.name : "Error",
        },
      );
      return context.json(
        rpcError(id, -32603, "ledgera: internal server error"),
      );
    }
  });

  app.get("/v1/log", async (context) => {
    const query = logQuery.safeParse(context.req.query());
    if (!query.success)
      throw new ServiceError("INVALID_QUERY", "Invalid log query", 400);
    return context.json({
      entries: await store.log(query.data.fromSeq, query.data.limit),
    });
  });

  app.get("/v1/log/head", async (context) => {
    const head = await store.head();
    return context.json({
      seq: (head?.seq ?? 0n).toString(),
      entryHash: head?.entryHash ?? genesisHash,
    });
  });

  app.get("/v1/receipts/:txHash", async (context) => {
    const parsed = hash.safeParse(context.req.param("txHash"));
    if (!parsed.success)
      throw new ServiceError("INVALID_HASH", "Invalid transaction hash", 400);
    const row = await store.receipt(parsed.data);
    if (!row)
      throw new ServiceError("RECEIPT_NOT_FOUND", "Receipt not found", 404);
    return context.json(receiptJson(row));
  });

  app.post("/v1/receipts/lookup", async (context) => {
    const parsed = receiptLookup.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      throw new ServiceError("INVALID_REQUEST", "Invalid receipt lookup", 400);
    return context.json({
      receipts: await store.receipts(parsed.data.txHashes),
    });
  });

  app.get("/v1/rejections", async (context) => {
    const query = logQuery.shape.limit.safeParse(context.req.query("limit"));
    if (!query.success)
      throw new ServiceError("INVALID_QUERY", "Invalid limit", 400);
    return context.json({ rejections: await store.rejections(query.data) });
  });

  return app;
}
