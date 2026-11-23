import { fileURLToPath } from "node:url";
import { openDatabase } from "@ledgera/shared/db";
import { type Hex, zeroHash } from "viem";
import { expect, test } from "vitest";
import type { AuditBlock, AuditReceipt, Violation } from "../src/checks.ts";
import { AuditStore } from "../src/db/store.ts";
import { auditorApp } from "../src/http.ts";

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

      const persisted = await store.inputs();
      expect(persisted.receipts).toEqual([receipt]);
      expect(persisted.blocks[0]?.hash).toBe(canonicalHash);
      const position = { block: 6n, index: 0, timestampMs: 125_000n };
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
          ],
          exclusions: [],
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
              position: { block: 5n, timestampMs: 121_000n, index: 0 },
            },
          ],
          violations: [],
          exclusions: [],
        },
      });
      expect(await summary("")).toMatchObject({
        lastBlockHash: replacementHash,
        violations: 0,
      });
    } finally {
      await database.close();
    }
  },
);
