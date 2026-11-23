import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/routes/rpc.ts";

const app = createApp({
  l2: "http://execution:8545",
  rollup: "http://rollup:8547",
});

const rpc = (method: string, id: number | string | null = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
});

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllGlobals());

test.each([
  {
    path: "/",
    upstream: "http://execution:8545",
    methods: [
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
    ],
  },
  {
    path: "/rollup",
    upstream: "http://rollup:8547",
    methods: ["optimism_syncStatus", "optimism_rollupConfig"],
  },
])(
  "forwards permitted requests to $upstream",
  async ({ path, upstream, methods }) => {
    const body = methods.map((method, id) => ({
      ...rpc(method, id),
      params: [],
    }));
    const upstreamResponse = methods.map((_, id) => ({
      jsonrpc: "2.0",
      id,
      result: "0x1",
    }));
    const fetchUpstream = vi
      .fn()
      .mockResolvedValue(Response.json(upstreamResponse));
    vi.stubGlobal("fetch", fetchUpstream);

    const response = await post(path, body);
    expect(await response.json()).toEqual(upstreamResponse);
    expect(fetchUpstream).toHaveBeenCalledExactlyOnceWith(
      upstream,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
        redirect: "error",
      }),
    );
  },
);

test.each([
  ["/", "eth_sendRawTransaction"],
  ["/", "eth_sendTransaction"],
  ["/", "txpool_content"],
  ["/", "admin_addPeer"],
  ["/", "optimism_syncStatus"],
  ["/rollup", "eth_blockNumber"],
])("rejects %s %s before contacting the upstream", async (path, method) => {
  const fetchUpstream = vi.fn();
  vi.stubGlobal("fetch", fetchUpstream);
  const response = await post(path, rpc(method, "request"));
  expect(await response.json()).toEqual({
    jsonrpc: "2.0",
    id: "request",
    error: { code: -32601, message: "Method not found" },
  });
  expect(fetchUpstream).not.toHaveBeenCalled();
});

test("rejects all requests in a mixed batch, with no response entry for notifications", async () => {
  const fetchUpstream = vi.fn();
  vi.stubGlobal("fetch", fetchUpstream);
  const response = await post("/", [
    rpc("eth_blockNumber", 0),
    { jsonrpc: "2.0", method: "eth_chainId" },
    rpc("eth_sendRawTransaction", "blocked"),
  ]);
  expect(await response.json()).toEqual([
    {
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32601, message: "Method not found" },
    },
    {
      jsonrpc: "2.0",
      id: "blocked",
      error: { code: -32601, message: "Method not found" },
    },
  ]);
  expect(fetchUpstream).not.toHaveBeenCalled();
});

test("re-encodes requests before forwarding them, including duplicate method keys", async () => {
  const fetchUpstream = vi
    .fn()
    .mockResolvedValue(Response.json({ result: "0x1" }));
  vi.stubGlobal("fetch", fetchUpstream);
  await app.request("/", {
    method: "POST",
    body: '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","method":"eth_blockNumber"}',
  });
  expect(fetchUpstream).toHaveBeenCalledExactlyOnceWith(
    "http://execution:8545",
    expect.objectContaining({ body: JSON.stringify(rpc("eth_blockNumber")) }),
  );
});
