import { ledgerForwarderAbi } from "@ledgera/abis";
import { encodeFunctionData, type Hex, keccak256, zeroHash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { expect, test, vi } from "vitest";
import type { ForwardPayload } from "../src/db/transfers.ts";
import {
  matchesForwardCall,
  transferGateway,
} from "../src/transfer-gateway.ts";

const forwarder = "0x1111111111111111111111111111111111111111";
const payload: ForwardPayload = {
  from: "0x2222222222222222222222222222222222222222",
  to: "0x3333333333333333333333333333333333333333",
  gas: "200000",
  value: "0",
  deadline: 1_800_000_000,
  data: "0xabcd",
  signature: "0x1234",
};
const operation = { ...payload, gas: BigInt(payload.gas), value: 0n };
const execute = encodeFunctionData({
  abi: ledgerForwarderAbi,
  functionName: "execute",
  args: [operation],
});
const executeAll = encodeFunctionData({
  abi: ledgerForwarderAbi,
  functionName: "executeAll",
  args: [[operation]],
});

test("matches all signed fields in an individual or batched forwarded call", () => {
  for (const data of [execute, executeAll]) {
    expect(matchesForwardCall(data, payload)).toBe(true);
    expect(
      matchesForwardCall(data, { ...payload, deadline: payload.deadline + 1 }),
    ).toBe(false);
    expect(matchesForwardCall(data, { ...payload, signature: "0x1235" })).toBe(
      false,
    );
  }
  expect(matchesForwardCall("0x", payload)).toBe(false);
});

test("picks a forwarded match over earlier rejections and checks raw transaction hashes", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  async function row(
    seq: number,
    data: Hex,
    forwardStatus: "rejected" | "forwarded",
  ) {
    const rawTx = await account.signTransaction({
      type: "eip1559",
      chainId: 31337,
      nonce: seq,
      gas: 350_000n,
      to: forwarder,
      maxFeePerGas: 100_000_000_000n,
      maxPriorityFeePerGas: 1n,
      data,
    });
    return {
      seq: String(seq),
      txHash: keccak256(rawTx),
      rawTx,
      forwardStatus,
      source: "relay",
    };
  }
  const rejected = await row(1, execute, "rejected");
  const accepted = await row(2, executeAll, "forwarded");
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ seq: "2" }))
    .mockResolvedValueOnce(Response.json({ entries: [rejected] }))
    .mockResolvedValueOnce(Response.json({ entries: [accepted] }))
    .mockResolvedValueOnce(Response.json({ seq: "2" }))
    .mockResolvedValueOnce(
      Response.json({ entries: [{ ...rejected, txHash: zeroHash }, accepted] }),
    );
  const gateway = transferGateway(
    "http://gateway.invalid",
    "fixture",
    forwarder,
    request,
  );
  await expect(gateway.find(payload, 1n)).resolves.toEqual({
    status: "accepted",
    seq: 2n,
    txHash: accepted.txHash,
  });
  await expect(gateway.find(payload, 1n)).rejects.toMatchObject({
    code: "GATEWAY_LOG_INVALID",
  });
});

test("keeps credential failures retryable and rejects gaps in acknowledged Gateway history", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
    )
    .mockResolvedValueOnce(Response.json({ seq: "4" }))
    .mockResolvedValueOnce(Response.json({ entries: [] }));
  const gateway = transferGateway(
    "http://gateway.invalid",
    "fixture",
    forwarder,
    request,
  );
  await expect(gateway.forward(payload, false)).resolves.toEqual({
    status: "unavailable",
  });
  await expect(gateway.find(payload, 3n)).rejects.toMatchObject({
    code: "GATEWAY_LOG_INVALID",
  });
});
