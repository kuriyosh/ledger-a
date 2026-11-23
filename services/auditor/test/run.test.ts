import { type Hex, zeroHash } from "viem";
import { expect, test, vi } from "vitest";
import type { AuditBlock, AuditReceipt } from "../src/checks.ts";
import { createAuditRunner, isLagging, scanReceipts } from "../src/run.ts";

const first: AuditReceipt = {
  seq: 1n,
  entryHash: zeroHash,
  txHash: zeroHash,
  prevHash: zeroHash,
  sender: "0x1111111111111111111111111111111111111111",
  receivedAtMs: 1_000n,
  rawTx: "0x01",
  signature: "0x01",
  forwardStatus: "queued",
  forwardError: null,
};
const hash: Hex = `0x${"1".repeat(64)}`;
const second = { ...first, seq: 2n, entryHash: hash, txHash: hash };
const signal = new AbortController().signal;

test("a full scan preserves archived signed receipts even if Gateway rewrites or removes them", async () => {
  const changed = {
    ...first,
    signature: "0x02" as const,
    forwardStatus: "rejected",
  };
  const page = vi.fn(async (from: bigint) => (from === 1n ? [changed] : []));
  const results = await scanReceipts(
    {
      async head() {
        return { seq: 1n, entryHash: zeroHash };
      },
      page,
    },
    [first, second],
    true,
    signal,
  );
  expect(results.receipts).toEqual([first, second]);
  expect(results.problems).toMatchObject([
    {
      type: "BROKEN_CHAIN",
      seqA: 1n,
      observationId: expect.stringMatching(/^0x/),
      evidence: {
        archived: { signature: "0x01" },
        observed: { signature: "0x02" },
      },
    },
  ]);
  expect(results.problems[0].evidence.archived).not.toHaveProperty(
    "forwardStatus",
  );
});

test("a repeated old page terminates and reports the unexpected sequence", async () => {
  const page = vi.fn(async () => [first]);
  const results = await scanReceipts(
    {
      async head() {
        return { seq: 2n, entryHash: hash };
      },
      page,
    },
    [],
    false,
    signal,
  );
  expect(page.mock.calls).toHaveLength(2);
  expect(results.receipts).toEqual([first]);
  expect(results.problems[0]).toMatchObject({
    type: "BROKEN_CHAIN",
    evidence: { expectedSeq: 2n },
  });
});

test("distinguishes an older RPC tip on the same fork from a shorter competing fork", async () => {
  const firstBlock: AuditBlock = {
    number: 2n,
    hash,
    parentHash: zeroHash,
    timestampMs: 1000n,
    transactions: [],
    commitments: [],
  };
  const later = { ...firstBlock, number: 3n, hash: zeroHash };
  const source = { blockHash: vi.fn(async () => hash) };
  expect(await isLagging(source, [firstBlock, later], 2n)).toBe(true);
  expect(source.blockHash).toHaveBeenCalledWith(2n);
  source.blockHash.mockResolvedValueOnce(zeroHash);
  expect(await isLagging(source, [firstBlock, later], 2n)).toBe(false);
  expect(await isLagging(source, [firstBlock, later], 3n)).toBe(false);
});

test("a full scan reports an archived sequence omitted below a stable Gateway head", async () => {
  const third = { ...second, seq: 3n };
  const result = await scanReceipts(
    {
      async head() {
        return { seq: 3n, entryHash: hash };
      },
      async page() {
        return [first, third];
      },
    },
    [first, second, third],
    true,
    signal,
  );
  expect(result.receipts).toHaveLength(3);
  expect(result.problems).toMatchObject([
    {
      type: "BROKEN_CHAIN",
      seqA: 2n,
      evidence: { archived: { seq: 2n, entryHash: hash } },
    },
  ]);
});

test("continues from a committed checkpoint without reloading or re-fetching history", async () => {
  const genesisHash = zeroHash;
  const firstBlock: AuditBlock = {
    number: 1n,
    hash,
    parentHash: zeroHash,
    timestampMs: 1000n,
    transactions: [],
    commitments: [],
  };
  const nextHash: Hex = `0x${"2".repeat(64)}`;
  const nextBlock = {
    ...firstBlock,
    number: 2n,
    hash: nextHash,
    parentHash: hash,
    timestampMs: 2000n,
  };
  const tip = vi
    .fn()
    .mockResolvedValueOnce(1n)
    .mockResolvedValueOnce(2n)
    .mockResolvedValueOnce(1n);
  const source = {
    chainId: async () => 31337,
    tip,
    blockHash: vi.fn(async (height: bigint) =>
      height === 1n ? hash : nextHash,
    ),
    policy: async () => ({
      chainId: 31337,
      genesisHash,
      verifyingContract: first.sender,
      gatewaySigner: first.sender,
    }),
    readSender: vi.fn(async () => ({ active: true, balance: 1_000_000n })),
    blocks: vi.fn(async (from: bigint) => [
      from === 1n ? firstBlock : nextBlock,
    ]),
  };
  const store = {
    inputs: vi.fn(async () => ({
      blocks: [],
      receipts: [],
      decisions: new Map(),
      state: undefined,
    })),
    persist: vi.fn(
      async (
        changes: Parameters<
          import("../src/db/store.ts").AuditStore["persist"]
        >[0],
      ) => ({
        id: 1,
        lastSeq: changes.lastSeq,
        lastBlock: changes.tip?.number ?? null,
        lastBlockHash: changes.tip?.hash ?? null,
        updatedAt: new Date(),
      }),
    ),
  };
  const gateway = {
    head: vi.fn(async () => ({ seq: 0n, entryHash: genesisHash })),
    page: vi.fn(async () => []),
  };
  const worker = createAuditRunner({
    source,
    gateway,
    store,
    signal,
    startBlock: 2n,
    intervalMs: 1000,
    inclusionDeadlineMs: 120_000n,
    timeToleranceMs: 5_000n,
  });
  await worker.run();
  await worker.run();
  await worker.run();
  expect(store.inputs).toHaveBeenCalledTimes(1);
  expect(store.persist).toHaveBeenCalledTimes(2);
  expect(source.blocks.mock.calls).toEqual([
    [1n, 1n],
    [2n, 2n],
  ]);
});

test("records a skipped sequence once while the Gateway head advances", async () => {
  const third = { ...second, seq: 3n };
  const later = { ...third, seq: 4n };
  const after = { ...later, seq: 5n };
  const scan = async (headSeq: bigint) =>
    scanReceipts(
      {
        head: vi
          .fn()
          .mockResolvedValueOnce({ seq: headSeq, entryHash: hash })
          .mockResolvedValueOnce({ seq: headSeq + 1n, entryHash: hash }),
        async page() {
          return [first, third, later, after];
        },
      },
      [first, second, third],
      true,
      signal,
    );
  const [a, b] = await Promise.all([scan(3n), scan(5n)]);
  expect(a.problems).toHaveLength(1);
  expect(b.problems).toHaveLength(1);
  expect(a.problems[0].seqA).toBe(2n);
  expect(a.problems[0].observationId).toBe(b.problems[0].observationId);
});

test("reports an incomplete log separately from a skipped receipt", async () => {
  const skipped = await scanReceipts(
    {
      async head() {
        return { seq: 2n, entryHash: hash };
      },
      async page() {
        return [];
      },
    },
    [first, second],
    true,
    signal,
  );
  expect(skipped.problems).toMatchObject([
    {
      type: "BROKEN_CHAIN",
      detail: "Gateway log did not reach the advertised head",
      evidence: { fromSeq: 1n, advertised: { seq: 2n } },
    },
  ]);
});

test.each([
  { seq: 2n, entryHash: zeroHash },
  { seq: 3n, entryHash: zeroHash },
])(
  "reports a head rollback or rewrite at the same sequence",
  async (changed) => {
    const third = { ...second, seq: 3n };
    const result = await scanReceipts(
      {
        head: vi
          .fn()
          .mockResolvedValueOnce({ seq: 3n, entryHash: hash })
          .mockResolvedValueOnce(changed),
        async page() {
          return [first, third];
        },
      },
      [first, second, third],
      true,
      signal,
    );
    expect(result.problems).toMatchObject([
      {
        type: "BROKEN_CHAIN",
        detail: "Gateway changed its head without appending",
        evidence: {
          advertised: { seq: 3n, entryHash: hash },
          observed: changed,
        },
      },
    ]);
  },
);
