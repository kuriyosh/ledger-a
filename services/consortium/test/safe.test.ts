import { kycRegistryAbi } from "@ledgera/abis";
import { decodeFunctionData, getAddress, padHex, zeroHash } from "viem";
import { expect, test } from "vitest";
import { proposalCall, proposalInput } from "../src/proposals.ts";
import { safeSignatures } from "../src/safe.ts";

const registry = getAddress("0x0000000000000000000000000000000000000700");
const first = getAddress("0x000000000000000000000000000000000000000a");
const second = getAddress("0x000000000000000000000000000000000000000b");
const raw = { to: first, data: "0x" } as const;

test("encodes Registry actions with the right role and status values", () => {
  const examples = [
    {
      type: "BLOCK_ACCOUNT",
      params: { account: first, reasonId: zeroHash },
      fn: "blockAccount",
      args: [first, zeroHash],
    },
    {
      type: "UNBLOCK_ACCOUNT",
      params: { account: first },
      fn: "unblockAccount",
      args: [first],
    },
    {
      type: "REGISTER_VASP",
      params: {
        vaspId: 4,
        admin: first,
        travelRuleSigner: second,
        name: "Fixture",
        endpoint: "http://vasp.invalid",
      },
      fn: "registerVasp",
      args: [4, first, second, "Fixture", "http://vasp.invalid"],
    },
    {
      type: "SET_VASP_STATUS",
      params: { vaspId: 4, status: "SUSPENDED" },
      fn: "setVaspStatus",
      args: [4, 2],
    },
    {
      type: "REGISTER_OPERATOR_ACCOUNT",
      params: { account: second, vaspId: 0, kind: "OPERATOR" },
      fn: "registerOperatorAccount",
      args: [second, 0, 4],
    },
  ];
  for (const { type, params, fn, args } of examples) {
    const call = proposalCall(
      registry,
      proposalInput.parse({ type, params, reason: "Fixture" }),
    );
    expect(call.to).toBe(registry);
    expect(
      decodeFunctionData({ abi: kycRegistryAbi, data: call.data }),
    ).toEqual({ functionName: fn, args });
  }
  expect(
    proposalCall(
      registry,
      proposalInput.parse({ type: "RAW", params: raw, reason: "Fixture" }),
    ),
  ).toEqual(raw);
});

test("sorts prevalidated owner signatures by address and uses v=1", () => {
  const expected = [first, second]
    .map((address) => `${padHex(address).slice(2)}${zeroHash.slice(2)}01`)
    .join("");
  expect(safeSignatures([second, first])).toBe(`0x${expected.toLowerCase()}`);
});
