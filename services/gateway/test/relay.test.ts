import { ledgerForwarderAbi, ledgerTokenAbi } from "@ledgera/abis";
import { signForwardRequest } from "@ledgera/shared/forward-request";
import { type Address, decodeFunctionData, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { createRelayAuth, prepareForwardCall } from "../src/domain/relay.ts";

const sender = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const token = "0x1111111111111111111111111111111111111111";
const swap = "0x2222222222222222222222222222222222222222";
const forwarder = "0x3333333333333333333333333333333333333333";
const policy = {
  chainId: 31337,
  forwarder,
  tokenAddresses: [token],
  swap,
  gasLimit: 5_000_000n,
} as const;
const registry = {
  async vaspOf(address: Address) {
    expect(address).toBe(sender.address);
    return 1;
  },
  async forwarderNonce(address: Address) {
    expect(address).toBe(sender.address);
    return 10n;
  },
};

async function approve(nonce: bigint, deadline = 200) {
  const request = {
    from: sender.address,
    to: token,
    value: 0n,
    gas: 150_000n,
    deadline,
    data: encodeFunctionData({
      abi: ledgerTokenAbi,
      functionName: "approve",
      args: [swap, 1n],
    }),
    nonce,
  } as const;
  const signature = await signForwardRequest(
    sender,
    { chainId: policy.chainId, verifyingContract: forwarder },
    request,
  );
  return { ...request, signature };
}

test("limits each authenticated VASP independently", () => {
  let time = 0;
  const authorize = createRelayAuth(
    { 1: "test-a", 2: "test-b" },
    1,
    () => time,
  );
  expect(() => authorize("Bearer bad")).toThrow(
    expect.objectContaining({ code: "UNAUTHORIZED" }),
  );
  expect(authorize("Bearer test-a")).toBe(1);
  expect(() => authorize("Bearer test-a")).toThrow(
    expect.objectContaining({ code: "RATE_LIMITED" }),
  );
  expect(authorize("Bearer test-b")).toBe(2);
  time += 60_000;
  expect(authorize("Bearer test-a")).toBe(1);
});

test("signatures in a batch use consecutive Forwarder nonces per signer", async () => {
  const first = await approve(10n);
  const second = await approve(11n);
  const single = await prepareForwardCall(policy, registry, 1, [first], 100);
  expect(
    decodeFunctionData({ abi: ledgerForwarderAbi, data: single.data })
      .functionName,
  ).toBe("execute");
  const batch = await prepareForwardCall(
    policy,
    registry,
    1,
    [first, second],
    100,
  );
  expect(
    decodeFunctionData({ abi: ledgerForwarderAbi, data: batch.data })
      .functionName,
  ).toBe("executeAll");
  expect(
    batch.operations.map(({ from, to, selector }) => ({ from, to, selector })),
  ).toEqual(
    Array.from({ length: 2 }, () => ({
      from: sender.address,
      to: token,
      selector: "0x095ea7b3",
    })),
  );
});

test("rejects disallowed targets, foreign signers, and mismatched nonce or deadline", async () => {
  const valid = await approve(10n);
  await expect(
    prepareForwardCall(policy, registry, 1, [{ ...valid, to: forwarder }], 100),
  ).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
  await expect(
    prepareForwardCall(policy, registry, 2, [valid], 100),
  ).rejects.toMatchObject({ code: "SIGNER_NOT_OF_VASP" });
  await expect(
    prepareForwardCall(policy, registry, 1, [valid, valid], 100),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    prepareForwardCall(policy, registry, 1, [valid], 201),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});
