import { ledgerForwarderAbi, ledgerTokenAbi } from "@ledgera/abis";
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  zeroAddress,
} from "viem";
import { expect, test } from "vitest";
import { decoder } from "../src/decode.ts";

export const address = (index: number) =>
  `0x${index.toString(16).padStart(40, "0")}` as Address;

export const contracts = {
  atomicSwap: address(1),
  consortiumSafe: address(2),
  depositProbe: address(3),
  kycRegistry: address(4),
  ledgerForwarder: address(5),
  receiptLog: address(6),
  tJPY: address(7),
  tUSD: address(8),
  travelRuleCompliance: address(9),
};

test("decodes known calls, Forwarder signers, and ABI amounts with full precision", () => {
  const receiver = address(16);
  const signer = address(11);
  const amount = (1n << 255n) + 1n;
  const data = encodeFunctionData({
    abi: ledgerTokenAbi,
    functionName: "transfer",
    args: [receiver, amount],
  });
  const input = encodeFunctionData({
    abi: ledgerForwarderAbi,
    functionName: "executeAll",
    args: [
      [
        {
          from: signer,
          to: contracts.tUSD,
          deadline: 17,
          value: 0n,
          gas: 1n,
          data,
          signature: "0xab",
        },
      ],
    ],
  });
  const result = decoder(contracts)({
    type: 2,
    from: address(12),
    to: contracts.ledgerForwarder,
    input,
    logs: [],
  });
  expect(result).toMatchObject({
    kind: "TOKEN_TRANSFER",
    call: {
      contract: "LedgerForwarder",
      function: "executeAll",
      inner: [
        {
          signer,
          to: contracts.tUSD,
          contract: "tUSD",
          function: "transfer",
          args: { to: receiver, value: amount.toString() },
        },
      ],
    },
  });
  expect(() => JSON.stringify(result)).not.toThrow();
});

test("only recognizes ERC20 events emitted by the deployed tokens", () => {
  const recipient = address(11);
  const topics = encodeEventTopics({
    abi: ledgerTokenAbi,
    eventName: "Transfer",
    args: { from: zeroAddress, to: recipient },
  });
  const log = {
    topics: topics.filter((topic) => typeof topic === "string"),
    data: encodeAbiParameters([{ type: "uint256" }], [9n]),
    logIndex: 1,
  };
  const result = decoder(contracts)({
    type: 2,
    from: address(12),
    to: address(13),
    input: "0x",
    logs: [
      { ...log, address: address(13) },
      { ...log, address: contracts.tUSD, logIndex: 2 },
    ],
  });
  expect(result).toEqual({
    kind: "TOKEN_MINT",
    call: undefined,
    events: [
      {
        contract: "tUSD",
        name: "Transfer",
        logIndex: 2,
        args: { from: zeroAddress, to: recipient, value: "9" },
      },
    ],
  });
});
