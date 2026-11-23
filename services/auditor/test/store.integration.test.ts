import { fileURLToPath } from "node:url";
import { openDatabase } from "@ledgera/shared/db";
import { type Hex, zeroHash } from "viem";
import { expect, test, vi } from "vitest";
import {
  type AuditBlock,
  type AuditReceipt,
  auditJson,
  type Violation,
} from "../src/checks.ts";
import { AuditStore } from "../src/db/store.ts";
import { auditorApp } from "../src/http.ts";
import { createAuditRunner } from "../src/run.ts";

const connection = process.env.TEST_AUDITOR_DATABASE_URL;
const receipt: AuditReceipt = {
  seq: 1n,
  txHash: zeroHash,
  sender: "0x1111111111111111111111111111111111111111",
  entryHash: zeroHash,
  prevHash: zeroHash,
  signature: "0x",
  rawTx: "0x",
  receivedAtMs: 1_000n,
  forwardStatus: "forwarded",
  forwardError: null,
};
const canonicalHash: Hex = `0x${"a".repeat(64)}`;
const replacementHash: Hex = `0x${"b".repeat(64)}`;
const block: AuditBlock = {
  number: 5n,
  hash: canonicalHash,
  parentHash: zeroHash,
  timestampMs: 123_000n,
  commitments: [],
  transactions: [],
};
const missing: Violation = {
  check: "C5",
  type: "NOT_INCLUDED",
  seqA: receipt.seq,
  block: block.number,
  txHash: receipt.txHash,
  detail: "missing at deadline",
  evidence: { receipt },
};

test.skipIf(!connection)(
  "persists findings, filters periods, and replaces orphaned findings",
  async () => {
    if (!connection)
      throw new Error("Set a disposable TEST_AUDITOR_DATABASE_URL");
    const migrations = fileURLToPath(
      new URL("../src/db/migrations/", import.meta.url),
    );
    const database = await openDatabase(connection, "auditor", migrations);
    try {
      const store = new AuditStore(database.db);
      const initial = await store.inputs();
      expect(initial.state).toBeUndefined();
      const unreceipted: Violation = {
        check: "C6",
        type: "UNRECEIPTED_TX",
        block: block.number,
        txHash: canonicalHash,
        detail: "not in receipt log",
        evidence: {},
      };
      const saved = {
        ancestor: 4n,
        blocks: [block],
        tip: block,
        lastSeq: 1n,
        reset: false,
        priorState: initial.state,
      };
      await store.persist({
        ...saved,
        snapshot: {
          entries: [{ receipt }],
          violations: [missing, unreceipted],
          exclusions: [],
          decisions: [],
        },
      });
      const app = auditorApp(new AuditStore(database.db), async () => {});
      async function summary(query: string) {
        const response = await app.request(`/v1/fifo/summary${query}`);
        expect(response.status).toBe(200);
        return response.json();
      }
      expect(await summary("")).toMatchObject({
        lastSeq: "1",
        lastBlock: "5",
        violations: 2,
      });
      expect(await summary("?fromSeq=2")).toMatchObject({
        violations: 1,
        checks: { C5: 0, C6: 1 },
      });
      expect(await summary("?fromBlock=6")).toMatchObject({
        violations: 1,
        checks: { C5: 1, C6: 0 },
      });
      expect(await summary("?fromSeq=2&fromBlock=6")).toMatchObject({
        violations: 0,
      });

      const persistent: Violation = {
        check: "C2",
        type: "BROKEN_CHAIN",
        seqA: 1n,
        detail: "conflicting gateway receipt",
        evidence: {
          archived: receipt,
          observed: { ...receipt, signature: "0x11" },
        },
        observationId: "conflict-fixture",
      };
      const persisted = await store.inputs();
      expect(persisted.receipts).toEqual([receipt]);
      expect(persisted.blocks[0]?.hash).toBe(canonicalHash);
      const position = {
        block: 6n,
        blockHash: replacementHash,
        index: 0,
        timestampMs: 125_000n,
      };
      const added = {
        ...block,
        number: 6n,
        parentHash: canonicalHash,
        hash: replacementHash,
      };
      const priorFinding = (
        await store.listViolations({ fromSeq: 1n, fromBlock: 0n })
      )[0];
      await store.persist({
        ...saved,
        ancestor: 5n,
        blocks: [added],
        tip: added,
        priorState: persisted.state,
        snapshot: {
          entries: [{ receipt, position }],
          violations: [
            { ...missing, evidence: { receipt, position } },
            unreceipted,
            persistent,
          ],
          exclusions: [],
          decisions: [],
        },
      });
      const late = (
        await store.listViolations({ fromSeq: 1n, fromBlock: 0n })
      )[0];
      expect(late.id).toBe(priorFinding.id);
      expect(late.detectedAt).toEqual(priorFinding.detectedAt);
      expect(late.evidence).toMatchObject({
        position: { block: "6", index: 0 },
      });

      const replacement = { ...block, hash: replacementHash };
      await store.persist({
        ...saved,
        blocks: [replacement],
        tip: replacement,
        priorState: (await store.inputs()).state,
        snapshot: {
          entries: [
            {
              receipt,
              position: {
                block: 5n,
                blockHash: replacementHash,
                timestampMs: 121_000n,
                index: 0,
              },
            },
          ],
          violations: [],
          exclusions: [],
          decisions: [],
        },
      });
      expect(await summary("")).toMatchObject({
        lastBlockHash: replacementHash,
        violations: 1,
        checks: { C2: 1, C5: 0, C6: 0 },
      });
      const storedAncestor = replacement;
      const previousHash: Hex = `0x${"c".repeat(64)}`;
      const currentHash: Hex = `0x${"d".repeat(64)}`;
      let end = {
        ...storedAncestor,
        number: 6n,
        hash: previousHash,
        parentHash: replacementHash,
        timestampMs: 128_000n,
      };
      const source = {
        chainId: async () => 31337,
        tip: async () => end.number,
        blockHash: async (height: bigint) =>
          height === 5n ? replacementHash : end.hash,
        blocks: async () => [end],
        policy: async () => ({
          chainId: 31337,
          verifyingContract: receipt.sender,
          gatewaySigner: receipt.sender,
          genesisHash: zeroHash,
        }),
        readSender: async () => ({ active: true, balance: 1_000_000n }),
      };
      const reads = vi.fn(() => store.inputs());
      const checked = vi.fn(
        async (step: Parameters<AuditStore["persist"]>[0]) => {
          expect(step.priorState).toEqual((await store.inputs()).state);
          const state = await store.persist(step);
          const persisted = await store.inputs();
          expect(persisted.state).toEqual(state);
          expect(persisted.blocks.at(-1)?.hash).toBe(step.tip?.hash);
          expect(auditJson(persisted.receipts)).toEqual(
            auditJson(step.snapshot.entries.map((entry) => entry.receipt)),
          );
          expect(auditJson([...persisted.decisions])).toEqual(
            auditJson(
              step.snapshot.decisions.map((decision) => [
                decision.seq,
                decision,
              ]),
            ),
          );
          return state;
        },
      );
      const worker = createAuditRunner({
        source,
        gateway: {
          head: async () => ({ seq: 1n, entryHash: receipt.entryHash }),
          page: async () => [receipt],
        },
        store: { inputs: reads, persist: checked },
        signal: new AbortController().signal,
        startBlock: 6n,
        intervalMs: 1000,
        inclusionDeadlineMs: 125_000n,
        timeToleranceMs: 5_000n,
      });
      await worker.run();
      await worker.run();
      end = { ...end, hash: currentHash };
      await worker.run();
      expect(reads).toHaveBeenCalledTimes(1);
      expect(checked).toHaveBeenCalledTimes(3);
      expect((await store.inputs()).decisions.get(1n)?.deadlineHash).toBe(
        currentHash,
      );
    } finally {
      await database.close();
    }
  },
);
