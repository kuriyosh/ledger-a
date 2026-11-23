import { ledgerForwarderAbi, ledgerTokenAbi } from "@ledgera/abis";
import type { Deployment } from "@ledgera/config";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  zeroHash,
} from "viem";
import { expect, test } from "vitest";
import type { ForwardPayload } from "../src/db/transfers.ts";
import { transferChain } from "../src/transfer-chain.ts";

const forwarder: Hex = "0x1111111111111111111111111111111111111111";
const sender = "0x2222222222222222222222222222222222222222";
const token: Hex = "0x3333333333333333333333333333333333333333";
const beneficiary = "0x4444444444444444444444444444444444444444";
const wrapper = "0x5555555555555555555555555555555555555555";
const payload: ForwardPayload = {
  from: sender,
  to: token,
  value: "0",
  gas: "200000",
  deadline: 1_800_000_000,
  data: "0x1234",
  signature: "0x01",
};
const transferTopics = encodeEventTopics({
  abi: ledgerTokenAbi,
  eventName: "Transfer",
  args: { from: sender, to: beneficiary },
});
const forwardTopics = encodeEventTopics({
  abi: ledgerForwarderAbi,
  eventName: "ExecutedForwardRequest",
  args: { signer: sender },
});

function transfer(logIndex: number) {
  return {
    address: token,
    topics: transferTopics,
    logIndex,
    data: encodeAbiParameters([{ type: "uint256" }], [25n]),
  };
}
function forward(logIndex: number, nonce: bigint, success = true) {
  return {
    address: forwarder,
    topics: forwardTopics,
    logIndex,
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }],
      [nonce, success],
    ),
  };
}
function read(logs: Array<{ address: Hex; data: Hex; logIndex: number }>) {
  const deployment: Deployment = {
    environment: "anvil",
    chainId: 31337,
    enforcementBlock: 1,
    auditStartBlock: 2,
    vasps: { network: 0, a: 1, b: 2 },
    contracts: {
      ledgerForwarder: forwarder,
      tUSD: token,
      tJPY: sender,
      kycRegistry: wrapper,
      travelRuleCompliance: wrapper,
      atomicSwap: wrapper,
      receiptLog: wrapper,
      depositProbe: wrapper,
      consortiumSafe: wrapper,
    },
  };
  const client = {
    getTransaction: async () => ({
      hash: zeroHash,
      blockHash: zeroHash,
      to: wrapper,
      input: "0x00",
    }),
    getTransactionReceipt: async () => ({
      transactionHash: zeroHash,
      blockHash: zeroHash,
      blockNumber: 10n,
      status: "success",
      logs,
    }),
  } as unknown as Parameters<typeof transferChain>[0];
  return transferChain(client, deployment).execution(
    zeroHash,
    payload,
    beneficiary,
    25n,
    8n,
  );
}

test("binds a forwarded movement to the exact signer nonce even for an indirect call", async () => {
  await expect(
    read([forward(1, 7n), transfer(2), forward(3, 8n)]),
  ).resolves.toMatchObject({
    matches: false,
    executed: true,
    logIndex: 2,
  });
  await expect(
    read([transfer(1), forward(2, 7n), forward(3, 8n)]),
  ).resolves.toMatchObject({
    matches: false,
    executed: true,
    logIndex: undefined,
  });
  await expect(
    read([transfer(1), forward(2, 8n, false)]),
  ).resolves.toMatchObject({
    matches: false,
    executed: true,
    logIndex: undefined,
  });
});
