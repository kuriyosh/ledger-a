import { isDeepStrictEqual } from "node:util";
import type { openDatabase } from "@ledgera/shared/db";
import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { type AuditBlock, type audit, auditJson } from "../checks.ts";
import { receiptSchema, uint64 } from "../sources.ts";
import {
  auditBlocks,
  auditState,
  exclusions,
  fifoEntries,
  violations,
} from "./schema.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type Snapshot = Awaited<ReturnType<typeof audit>>;
const stateId = 1;
const blockSchema = z.object({
  number: uint64,
  hash: z.custom<AuditBlock["hash"]>(),
  parentHash: z.custom<AuditBlock["parentHash"]>(),
  timestampMs: uint64,
  transactions: z.custom<AuditBlock["transactions"]>(),
  commitments: z.array(
    z.object({
      fromSeq: uint64,
      toSeq: uint64,
      headHash: z.custom<AuditBlock["hash"]>(),
    }),
  ),
});

type Filters = { fromSeq: bigint; fromBlock: bigint };

function violationFilter({ fromSeq, fromBlock }: Filters) {
  return or(
    gte(violations.seqA, fromSeq),
    and(isNull(violations.seqA), gte(violations.block, fromBlock)),
  );
}

export class AuditStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async inputs() {
    return this.db.transaction(
      async (tx) => {
        const storedBlocks = await tx
          .select({ info: auditBlocks.info })
          .from(auditBlocks)
          .orderBy(asc(auditBlocks.number));
        const entries = await tx
          .select({ receipt: fifoEntries.receipt })
          .from(fifoEntries)
          .orderBy(asc(fifoEntries.seq));
        const [state] = await tx
          .select()
          .from(auditState)
          .where(eq(auditState.id, stateId));
        return {
          blocks: storedBlocks.map(({ info }) => blockSchema.parse(info)),
          receipts: entries.map(({ receipt }) => receiptSchema.parse(receipt)),
          state,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async persist({
    ancestor,
    blocks,
    snapshot,
    tip,
    lastSeq,
    reset,
    priorState,
  }: {
    ancestor: bigint;
    blocks: readonly AuditBlock[];
    snapshot: Snapshot;
    tip?: AuditBlock;
    lastSeq: bigint;
    reset: boolean;
    priorState: Awaited<ReturnType<AuditStore["inputs"]>>["state"] | undefined;
  }) {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(6157980750)`);
      const [active] = await tx
        .select()
        .from(auditState)
        .where(eq(auditState.id, stateId));
      if (
        active?.updatedAt.getTime() !== priorState?.updatedAt.getTime() ||
        active?.lastBlockHash !== priorState?.lastBlockHash ||
        active?.lastSeq !== priorState?.lastSeq
      ) {
        throw new Error("Audit checkpoint changed during inspection");
      }
      if (reset) {
        await tx.delete(auditBlocks);
        await tx.delete(fifoEntries);
        await tx.delete(violations);
        await tx.delete(exclusions);
      } else {
        await tx.delete(auditBlocks).where(gt(auditBlocks.number, ancestor));
        await tx.delete(violations).where(gt(violations.block, ancestor));
        await tx.delete(exclusions).where(gt(exclusions.block, ancestor));
      }
      for (let offset = 0; offset < blocks.length; offset += 1_000) {
        await tx.insert(auditBlocks).values(
          blocks.slice(offset, offset + 1_000).map((block) => ({
            number: block.number,
            hash: block.hash,
            info: auditJson(block),
          })),
        );
      }
      const failuresBySeq = new Map<
        bigint,
        Set<(typeof violations.$inferSelect)["check"]>
      >();
      const storedViolations = new Map(
        (await tx.select().from(violations)).map((row) => [row.identity, row]),
      );
      const visited = new Set<string>();
      for (const violation of snapshot.violations) {
        for (const seq of [violation.seqA, violation.seqB]) {
          if (seq === undefined) continue;
          let checks = failuresBySeq.get(seq);
          if (!checks) {
            checks = new Set();
            failuresBySeq.set(seq, checks);
          }
          checks.add(violation.check);
        }
        const identity = [
          violation.check,
          violation.seqA,
          violation.seqB,
          violation.txHash,
          violation.block,
          violation.detail,
        ].join(":");
        if (visited.has(identity)) continue;
        visited.add(identity);
        const previous = storedViolations.get(identity);
        const evidence = auditJson(violation.evidence);
        if (!previous) {
          await tx
            .insert(violations)
            .values({ ...violation, identity, evidence });
        } else if (!isDeepStrictEqual(previous.evidence, evidence)) {
          await tx
            .update(violations)
            .set({ evidence })
            .where(eq(violations.id, previous.id));
        }
        storedViolations.delete(identity);
      }
      if (storedViolations.size) {
        await tx.delete(violations).where(
          inArray(
            violations.id,
            Array.from(storedViolations.values(), (row) => row.id),
          ),
        );
      }

      const storedExclusions = new Map(
        (await tx.select().from(exclusions)).map((row) => [row.seq, row]),
      );
      for (const exclusion of snapshot.exclusions) {
        const previous = storedExclusions.get(exclusion.seq);
        const evidence = auditJson(exclusion.evidence);
        const values = { ...exclusion, evidence };
        if (!previous) await tx.insert(exclusions).values(values);
        else if (!isDeepStrictEqual(previous.evidence, evidence)) {
          await tx
            .update(exclusions)
            .set(values)
            .where(eq(exclusions.seq, exclusion.seq));
        }
        storedExclusions.delete(exclusion.seq);
      }
      if (storedExclusions.size) {
        await tx
          .delete(exclusions)
          .where(inArray(exclusions.seq, Array.from(storedExclusions.keys())));
      }

      const priorEntries = new Map(
        (await tx.select().from(fifoEntries)).map((row) => [row.seq, row]),
      );
      for (const { receipt, position } of snapshot.entries) {
        const previous = priorEntries.get(receipt.seq);
        const values = {
          seq: receipt.seq,
          txHash: receipt.txHash,
          receivedAtMs: receipt.receivedAtMs,
          forwardStatus: receipt.forwardStatus,
          posBlock: position?.block ?? null,
          posIndex: position?.index ?? null,
          position: position ? auditJson(position) : null,
          receipt: auditJson(receipt),
          checks: Array.from(failuresBySeq.get(receipt.seq) ?? []).sort(),
        };
        if (!previous) await tx.insert(fifoEntries).values(values);
        else if (!isDeepStrictEqual(previous, values)) {
          await tx
            .update(fifoEntries)
            .set(values)
            .where(eq(fifoEntries.seq, receipt.seq));
        }
      }

      const updated = {
        lastSeq,
        lastBlock: tip?.number ?? null,
        lastBlockHash: tip?.hash ?? null,
        updatedAt: new Date(),
      };
      await tx
        .insert(auditState)
        .values({ id: stateId, ...updated })
        .onConflictDoUpdate({ target: auditState.id, set: updated });
    });
  }

  async summary(filters: Filters) {
    const [state, failures, [omitted]] = await Promise.all([
      this.db.select().from(auditState).where(eq(auditState.id, stateId)),
      this.db
        .select({ check: violations.check, total: count() })
        .from(violations)
        .where(violationFilter(filters))
        .groupBy(violations.check),
      this.db
        .select({ total: count() })
        .from(exclusions)
        .where(gte(exclusions.seq, filters.fromSeq)),
    ]);
    const checks = { C1: 0, C2: 0, C3: 0, C4: 0, C5: 0, C6: 0, C7: 0 };
    for (const failure of failures) checks[failure.check] = failure.total;
    return {
      lastSeq: state[0]?.lastSeq ?? 0n,
      lastBlock: state[0]?.lastBlock ?? null,
      lastBlockHash: state[0]?.lastBlockHash ?? null,
      updatedAt: state[0]?.updatedAt ?? null,
      checks,
      violations: failures.reduce((total, finding) => total + finding.total, 0),
      exclusions: omitted.total,
    };
  }

  async listEntries(fromSeq: bigint, limit: number) {
    return this.db
      .select({
        receipt: fifoEntries.receipt,
        position: fifoEntries.position,
        checks: fifoEntries.checks,
      })
      .from(fifoEntries)
      .where(gte(fifoEntries.seq, fromSeq))
      .orderBy(asc(fifoEntries.seq))
      .limit(limit);
  }

  async listViolations(filters: Filters) {
    return this.db
      .select({
        id: violations.id,
        check: violations.check,
        type: violations.type,
        seqA: violations.seqA,
        seqB: violations.seqB,
        txHash: violations.txHash,
        block: violations.block,
        detail: violations.detail,
        evidence: violations.evidence,
        detectedAt: violations.detectedAt,
      })
      .from(violations)
      .where(violationFilter(filters))
      .orderBy(asc(violations.id));
  }

  async listExclusions(fromSeq: bigint) {
    return this.db
      .select()
      .from(exclusions)
      .where(gte(exclusions.seq, fromSeq))
      .orderBy(asc(exclusions.seq));
  }
}
