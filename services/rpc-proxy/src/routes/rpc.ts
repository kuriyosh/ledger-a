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

type Target = { l2: string; rollup?: string };

function selector(targets: Target[]) {
  if (targets.length < 2) return async () => targets;
  let ordered: Target[] = [];
  let validUntil = 0;
  let refresh: Promise<Target[]> | undefined;
  async function probe(target: Target) {
    const response = await fetch(target.l2, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(900),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
      }),
    });
    if (!response.ok) throw new Error("L2 upstream unavailable");
    const output = (await response.json()) as { result?: string };
    if (!output.result || !/^0x[0-9a-f]+$/i.test(output.result))
      throw new Error("Invalid upstream height");
    return { target, height: BigInt(output.result) };
  }
  return async () => {
    if (Date.now() < validUntil) return ordered;
    refresh ??= Promise.allSettled(targets.map(probe))
      .then((results) => {
        ordered = results
          .flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          )
          .sort((left, right) =>
            left.height > right.height
              ? -1
              : left.height < right.height
                ? 1
                : 0,
          )
          .map(({ target }) => target);
        validUntil = Date.now() + 1_000;
        return ordered;
      })
      .finally(() => {
        refresh = undefined;
      });
    return refresh;
  };
}

export function createApp(upstreams: {
  l2: string | string[];
  rollup?: string | string[];
}) {
  const l2 = typeof upstreams.l2 === "string" ? [upstreams.l2] : upstreams.l2;
  const rollup =
    typeof upstreams.rollup === "string"
      ? [upstreams.rollup]
      : (upstreams.rollup ?? []);
  const select = selector(
    l2.map((url, index) => ({ l2: url, rollup: rollup[index] })),
  );
  const app = new Hono();
  app.use(bodyLimit({ maxSize: 2 * 1024 * 1024 }));

  for (const { path, methods, key, enabled } of [
    { path: "/", methods: l2Methods, key: "l2", enabled: l2.length > 0 },
    {
      path: "/rollup",
      methods: rollupMethods,
      key: "rollup",
      enabled: rollup.length > 0,
    },
  ] as const) {
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
        !enabled ||
        requests.data.some(({ method }) => !methods.has(method))
      ) {
        const errors = requests.data.flatMap(({ id }) =>
          id === undefined ? [] : [rpcError(id, -32601, "Method not found")],
        );
        if (errors.length === 0) return context.body(null, 204);
        return context.json(isBatch ? errors : errors[0]);
      }

      // Upstream receives exactly the methods checked above.
      const bodyToSend = JSON.stringify(
        isBatch ? requests.data : requests.data[0],
      );
      for (const target of await select()) {
        const endpoint = target[key];
        if (!endpoint) continue;
        try {
          const result = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: bodyToSend,
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
          if (result.status >= 500 && l2.length > 1) {
            await result.body?.cancel();
            continue;
          }
          return new Response(result.body, {
            status: result.status,
            headers: { "content-type": "application/json" },
          });
        } catch {}
      }
      return context.json(
        rpcError(null, -32000, "RPC upstream unavailable"),
        502,
      );
    });
  }

  return app;
}
