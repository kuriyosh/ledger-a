import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  integer,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const demo = pgSchema("demo");
const height = (name: string) => bigint(name, { mode: "bigint" });
const utc = (name: string) => timestamp(name, { withTimezone: true });
const bytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const runs = demo.table("runs", {
  run: integer("run").primaryKey(),
  startedAt: utc("started_at").notNull(),
  startSeq: height("start_seq").notNull(),
  startBlock: height("start_block").notNull(),
  completedAt: utc("completed_at"),
});

export const mintRequests = demo.table(
  "mint_requests",
  {
    id: text("id").primaryKey(),
    token: text("token", { enum: ["tJPY", "tUSD"] }).notNull(),
    recipient: bytes("recipient").notNull(),
    amount: numeric("amount", {
      precision: 78,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    nonce: height("nonce").notNull(),
    firstBlock: height("first_block").notNull(),
    txHash: bytes("tx_hash").notNull().unique(),
    rawTx: bytes("raw_tx").notNull(),
    status: text("status", { enum: ["pending", "confirmed", "failed"] })
      .notNull()
      .default("pending"),
    blockHash: bytes("block_hash"),
  },
  (row) => [
    uniqueIndex("mint_one_pending")
      .on(row.status)
      .where(sql`${row.status} = 'pending'`),
    check("mint_positive_amount", sql`${row.amount} > 0`),
  ],
);

export const deposits = demo.table("enforcement_deposits", {
  id: text("id").primaryKey(),
  action: text("action", { enum: ["probe", "none"] }).notNull(),
  hash: text("hash").notNull().unique(),
  rawTx: text("raw_tx").notNull(),
  probeBefore: text("probe_before").notNull(),
  createdAt: utc("created_at").notNull().defaultNow(),
});
