import {
  hashReceiptEntry,
  receiptGenesisHash,
  signReceipt,
} from "@ledgera/shared/receipt";
import { type Hex, keccak256, numberToHex, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test, vi } from "vitest";
import {
  type AuditBlock,
  type AuditReceipt,
  audit,
  receiptEvidence,
} from "../src/checks.ts";

const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const customer = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const destination = "0x2222222222222222222222222222222222222222";
const domain = {
  chainId: 31337,
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;
const policy = {
  ...domain,
  gatewaySigner: signer.address,
  genesisHash: receiptGenesisHash(domain),
  inclusionDeadlineMs: 120_000n,
  timeToleranceMs: 5_000n,
};
const readSender = vi.fn(async () => ({ active: true, balance: 100_000_000n }));

async function receipt(
  seq: bigint,
  prevHash = policy.genesisHash,
  receivedAtMs = 10_000n,
): Promise<AuditReceipt> {
  const rawTx = await customer.signTransaction({
    type: "eip1559",
    chainId: policy.chainId,
    nonce: Number(seq - 1n),
    to: destination,
    gas: 21_000n,
    value: 1n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  });
  const data = {
    seq,
    txHash: keccak256(rawTx),
    sender: customer.address,
    receivedAtMs,
    prevHash,
  };
  return {
    ...data,
    rawTx,
    entryHash: hashReceiptEntry(data),
    signature: await signReceipt(signer, domain, data),
    forwardStatus: "queued",
    forwardError: null,
  };
}

function block(
  number: bigint,
  timestampMs: bigint,
  txHashes: Hex[] = [],
): AuditBlock {
  return {
    number,
    hash: numberToHex(number, { size: 32 }),
    parentHash: numberToHex(number - 1n, { size: 32 }),
    timestampMs,
    transactions: txHashes.map((hash) => ({ hash, deposit: false })),
    commitments: [],
  };
}

test("accepts a correctly signed ordered log, matching commit and Deposit", async () => {
  const first = await receipt(1n);
  const second = await receipt(2n, first.entryHash);
  const included = block(2n, 12_000n, [first.txHash, second.txHash]);
  included.transactions.unshift({ hash: zeroHash, deposit: true });
  included.commitments.push({
    fromSeq: 1n,
    toSeq: 2n,
    headHash: second.entryHash,
  });
  const result = await audit(
    [first, second],
    [block(1n, 8_000n), included],
    2n,
    policy,
    readSender,
  );
  expect(result.violations).toEqual([]);
  expect(result.exclusions).toEqual([]);
  expect(result.entries.map((entry) => entry.position?.index)).toEqual([1, 2]);
});

test("finds signature, sequence, commitment, order, unreceipted and timing violations", async () => {
  const first = await receipt(1n, policy.genesisHash, 17_001n);
  first.signature = "0x00";
  const third = await receipt(3n, zeroHash);
  const included = block(2n, 12_000n, [third.txHash, first.txHash, zeroHash]);
  included.commitments.push({ fromSeq: 2n, toSeq: 3n, headHash: zeroHash });
  const { violations } = await audit(
    [first, third],
    [included],
    2n,
    policy,
    readSender,
  );
  expect(violations.map((item) => item.check).sort()).toEqual([
    "C1",
    "C2",
    "C3",
    "C4",
    "C6",
    "C7",
  ]);
  expect(violations.find((item) => item.check === "C4")?.evidence).toEqual({
    earlier: {
      receipt: receiptEvidence(first),
      position: {
        block: 2n,
        blockHash: included.hash,
        index: 1,
        timestampMs: 12_000n,
      },
    },
    later: {
      receipt: receiptEvidence(third),
      position: {
        block: 2n,
        blockHash: included.hash,
        index: 0,
        timestampMs: 12_000n,
      },
    },
  });
});

test.each(["queued", "forwarded", "rejected", "held_demo"])(
  "checks inclusion independent of Gateway display status: %s",
  async (forwardStatus) => {
    const entry = {
      ...(await receipt(1n)),
      forwardStatus,
      forwardError: "SENDER_INACTIVE",
    };
    const initial = [block(1n, 8_000n), block(2n, 130_000n)];
    expect(
      (await audit([entry], initial, 2n, policy, readSender)).violations,
    ).toEqual([]);
    const overdue = [...initial, block(3n, 132_000n)];
    expect(
      (await audit([entry], overdue, 2n, policy, readSender)).violations,
    ).toMatchObject([{ type: "NOT_INCLUDED", block: 3n }]);
    const late = [...overdue, block(4n, 134_000n, [entry.txHash])];
    expect(
      (await audit([entry], late, 2n, policy, readSender)).violations,
    ).toMatchObject([
      {
        type: "NOT_INCLUDED",
        block: 3n,
        evidence: { position: { block: 4n, index: 0 } },
      },
    ]);
  },
);

test.each([
  { active: false, balance: 100_000_000n, reason: "SENDER_INACTIVE" },
  { active: true, balance: 210_000n, reason: "INSUFFICIENT_FUNDS" },
])(
  "uses an L2 state exclusion with evidence: $reason",
  async ({ reason, ...state }) => {
    const entry = await receipt(1n);
    const blocks = [
      block(1n, 8_000n),
      block(2n, 128_000n),
      block(3n, 132_000n),
    ];
    const historical = vi.fn(async () => state);
    const result = await audit([entry], blocks, 2n, policy, historical);
    expect(result.violations).toEqual([]);
    expect(result.exclusions).toMatchObject([
      { reason, block: 1n, evidence: { ...state, cost: 210_001n } },
    ]);
    expect(historical).toHaveBeenCalledExactlyOnceWith(
      customer.address,
      blocks[0],
    );
    const tampered = { ...entry, rawTx: "0x00" as const };
    const invalid = await audit([tampered], blocks, 2n, policy, historical);
    expect(invalid.violations[0]?.type).toBe("NOT_INCLUDED");
    expect(invalid.exclusions).toEqual([]);
  },
);

test("positions and C4 are recalculated for replacement blocks", async () => {
  const first = await receipt(1n);
  const second = await receipt(2n, first.entryHash);
  const canonical = [block(2n, 12_000n, [first.txHash, second.txHash])];
  const fork = [block(2n, 12_000n, [second.txHash, first.txHash])];
  expect(
    (await audit([first, second], canonical, 2n, policy, readSender))
      .violations,
  ).toEqual([]);
  expect(
    (await audit([first, second], fork, 2n, policy, readSender)).violations,
  ).toMatchObject([{ type: "ORDER_VIOLATION" }]);
});

test("does not use a late transaction's own debited balance to excuse it", async () => {
  const entry = await receipt(1n);
  const history = [
    block(1n, 8_000n),
    block(2n, 130_000n),
    block(3n, 132_000n, [entry.txHash]),
  ];
  const state = vi.fn(
    async (_: typeof customer.address, at: Pick<AuditBlock, "number">) => ({
      active: true,
      balance: at.number < 3n ? 210_001n : 1n,
    }),
  );
  const result = await audit([entry], history, 2n, policy, state);
  expect(result.exclusions).toEqual([]);
  expect(result.violations).toMatchObject([
    {
      type: "NOT_INCLUDED",
      evidence: {
        deadlineBlock: { hash: history[2].hash },
        position: { blockHash: history[2].hash },
      },
    },
  ]);
  expect(state).toHaveBeenCalledTimes(2);
  const archived = new Map(result.decisions.map((item) => [item.seq, item]));
  const noArchiveRpc = vi.fn(async () => {
    throw new Error("state pruned");
  });
  const repeated = await audit(
    [entry],
    history,
    2n,
    policy,
    noArchiveRpc,
    undefined,
    archived,
  );
  expect(repeated).toEqual(result);
  expect(noArchiveRpc).not.toHaveBeenCalled();
});
