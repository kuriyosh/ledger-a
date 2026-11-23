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
import {
  type AuditBlock,
  type audit,
  auditJson,
  type InclusionDecision,
} from "../checks.ts";
import { receiptSchema, uint64 } from "../sources.ts";
import {
  auditBlocks,
  auditState,
  exclusions,
  fifoEntries,
  inclusionDecisions,
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

const inclusionProof = z.object({
  seq: uint64,
  txHash: z.custom<InclusionDecision["txHash"]>(),
  reason: z.enum(["SENDER_INACTIVE", "INSUFFICIENT_FUNDS"]),
  block: uint64,
  evidence: z.record(z.string(), z.unknown()),
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
        const storedDecisions = await tx.select().from(inclusionDecisions);
        const [state] = await tx
          .select()
          .from(auditState)
          .where(eq(auditState.id, stateId));
        return {
          blocks: storedBlocks.map(({ info }) => blockSchema.parse(info)),
          receipts: entries.map(({ receipt }) => receiptSchema.parse(receipt)),
          decisions: new Map(
            storedDecisions.map(({ exclusion, ...row }) => [
              row.seq,
              {
                ...row,
                exclusion:
                  exclusion === null
                    ? undefined
                    : inclusionProof.parse(exclusion),
              },
            ]),
          ),
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
      if (reset) await tx.delete(auditBlocks);
      else await tx.delete(auditBlocks).where(gt(auditBlocks.number, ancestor));
      await tx.delete(violations).where(gt(violations.block, ancestor));
      await tx.delete(exclusions).where(gt(exclusions.block, ancestor));
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
      for (const saved of storedViolations.values()) {
        if (saved.observationId === null || saved.seqA === null) continue;
        failuresBySeq.set(saved.seqA, new Set(["C2"]));
      }
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
        const identity =
          [
            violation.check,
            violation.seqA,
            violation.seqB,
            violation.txHash,
            violation.block,
            violation.detail,
          ].join(":") +
          (violation.observationId ? `:${violation.observationId}` : "");
        if (visited.has(identity)) continue;
        visited.add(identity);
        const previous = storedViolations.get(identity);
        const evidence = auditJson(violation.evidence);
        if (!previous) {
          await tx
            .insert(violations)
            .values({ ...violation, identity, evidence });
        } else if (
          previous.observationId === null &&
          !isDeepStrictEqual(previous.evidence, evidence)
        ) {
          await tx
            .update(violations)
            .set({ evidence })
            .where(eq(violations.id, previous.id));
        }
        storedViolations.delete(identity);
      }
      const invalidated = Array.from(storedViolations.values())
        .filter((row) => row.observationId === null)
        .map((row) => row.id);
      if (invalidated.length) {
        await tx.delete(violations).where(inArray(violations.id, invalidated));
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

      const previousDecisions = new Map(
        (await tx.select().from(inclusionDecisions)).map((row) => [
          row.seq,
          row,
        ]),
      );
      for (const { exclusion, ...decision } of snapshot.decisions) {
        const row = {
          ...decision,
          exclusion: exclusion ? auditJson(exclusion) : null,
        };
        const previous = previousDecisions.get(decision.seq);
        if (!previous) await tx.insert(inclusionDecisions).values(row);
        else if (!isDeepStrictEqual(previous, row)) {
          await tx
            .update(inclusionDecisions)
            .set(row)
            .where(eq(inclusionDecisions.seq, decision.seq));
        }
        previousDecisions.delete(decision.seq);
      }
      if (previousDecisions.size) {
        await tx
          .delete(inclusionDecisions)
          .where(
            inArray(inclusionDecisions.seq, [...previousDecisions.keys()]),
          );
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
