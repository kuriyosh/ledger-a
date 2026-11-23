import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { Hex } from "viem";
import type { Exclusion, Violation } from "../checks.ts";

const auditor = pgSchema("auditor");
const sequence = (name: string) =>
  numeric(name, { precision: 20, scale: 0, mode: "bigint" });
const height = (name: string) => bigint(name, { mode: "bigint" });
const hash = (name: string) => text(name).$type<Hex>();
const instant = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const auditState = auditor.table("audit_state", {
  id: integer("id").primaryKey(),
  lastSeq: sequence("last_seq").notNull(),
  lastBlock: height("last_block"),
  lastBlockHash: hash("last_block_hash"),
  updatedAt: instant("updated_at"),
});

export const auditBlocks = auditor.table("audit_blocks", {
  number: height("block_number").primaryKey(),
  hash: hash("block_hash").notNull(),
  info: jsonb("info").notNull(),
});

export const fifoEntries = auditor.table("fifo_entries", {
  seq: sequence("seq").primaryKey(),
  txHash: hash("tx_hash").notNull(),
  receivedAtMs: sequence("received_at_ms").notNull(),
  forwardStatus: text("forward_status").notNull(),
  posBlock: height("pos_block"),
  posIndex: integer("pos_index"),
  receipt: jsonb("receipt").notNull(),
  position: jsonb("position"),
  checks: jsonb("checks").$type<Violation["check"][]>().notNull(),
});

export const violations = auditor.table(
  "violations",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    identity: text("identity").notNull().unique(),
    check: text("check_code").$type<Violation["check"]>().notNull(),
    type: text("type").$type<Violation["type"]>().notNull(),
    seqA: sequence("seq_a"),
    seqB: sequence("seq_b"),
    txHash: hash("tx_hash"),
    block: height("block_number"),
    detail: text("detail").notNull(),
    evidence: jsonb("evidence").notNull(),
    detectedAt: instant("detected_at"),
  },
  (row) => [
    index("violations_seq").on(row.seqA),
    index("violations_block").on(row.block),
  ],
);

export const exclusions = auditor.table("exclusions", {
  seq: sequence("seq").primaryKey(),
  txHash: hash("tx_hash").notNull(),
  reason: text("reason").$type<Exclusion["reason"]>().notNull(),
  block: height("verified_block").notNull(),
  evidence: jsonb("evidence").notNull(),
  detectedAt: instant("detected_at"),
});
