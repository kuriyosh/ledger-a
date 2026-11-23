import { type Address, encodeAbiParameters, type Hex } from "viem";
import { expect, test } from "vitest";
import { chainState } from "../src/state.ts";

test("sends the exact canonical block hash with contract state requests", async () => {
  const address = "0x0000000000000000000000000000000000000001" as Address;
  const blockHash = `0x${"ab".repeat(32)}` as Hex;
  const contracts = {
    atomicSwap: address,
    consortiumSafe: address,
    depositProbe: address,
    kycRegistry: address,
    ledgerForwarder: address,
    receiptLog: address,
    tJPY: address,
    tUSD: address,
    travelRuleCompliance: address,
  };
  const methods: string[] = [];
  const rpc: typeof fetch = async (input, init) => {
    const body = (await new Request(input, init).json()) as {
      id: number;
      method: string;
      params: unknown[];
    };
    methods.push(body.method);
    expect(body.params[1]).toEqual({ blockHash, requireCanonical: true });
    const result =
      body.method === "eth_getCode"
        ? "0x6000"
        : encodeAbiParameters([{ type: "uint256" }], [1n]);
    return Response.json({ id: body.id, jsonrpc: "2.0", result });
  };
  const state = chainState("http://127.0.0.1:8545", contracts, rpc);
  await expect(state.balance(address, address, blockHash)).resolves.toBe(1n);
  await expect(state.registry(blockHash)).resolves.toEqual({
    enforcementEnabled: true,
    registryVersion: 1n,
  });
  expect(methods.sort()).toEqual([
    "eth_call",
    "eth_call",
    "eth_call",
    "eth_getCode",
    "eth_getCode",
  ]);
});
