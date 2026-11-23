import { type Hex, zeroHash } from "viem";
import { expect, test, vi } from "vitest";
import type { AuditBlock, AuditReceipt } from "../src/checks.ts";
import { isLagging, scanReceipts } from "../src/run.ts";

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
