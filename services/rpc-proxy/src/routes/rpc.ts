import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

const l2Methods = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBlockReceipts",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_getLogs",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "net_version",
  "web3_clientVersion",
  "debug_traceTransaction",
]);
const rollupMethods = new Set(["optimism_syncStatus", "optimism_rollupConfig"]);

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z
    .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
    .optional(),
});

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function createApp(upstreams: { l2: string; rollup?: string }) {
  const app = new Hono();
  app.use(bodyLimit({ maxSize: 2 * 1024 * 1024 }));

  for (const { path, methods, upstream } of [
    { path: "/", methods: l2Methods, upstream: upstreams.l2 },
    { path: "/rollup", methods: rollupMethods, upstream: upstreams.rollup },
  ]) {
    app.post(path, async (context) => {
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json(rpcError(null, -32700, "Parse error"));
      }

      const isBatch = Array.isArray(body);
      const requests = z
        .array(requestSchema)
        .nonempty()
        .safeParse(isBatch ? body : [body]);
      if (!requests.success)
        return context.json(rpcError(null, -32600, "Invalid Request"));

      if (
        !upstream ||
        requests.data.some(({ method }) => !methods.has(method))
      ) {
        const errors = requests.data.flatMap(({ id }) =>
          id === undefined ? [] : [rpcError(id, -32601, "Method not found")],
        );
        if (errors.length === 0) return context.body(null, 204);
        return context.json(isBatch ? errors : errors[0]);
      }

      let result: Response;
      try {
        // Serialize the validated fields so upstream receives exactly the methods checked above.
        result = await fetch(upstream, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(isBatch ? requests.data : requests.data[0]),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return context.json(
          rpcError(null, -32000, "RPC upstream unavailable"),
          502,
        );
      }
      return new Response(result.body, {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    });
  }

  return app;
}
