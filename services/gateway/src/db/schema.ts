import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const gateway = pgSchema("gateway");
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const logEntries = gateway.table(
  "log_entries",
  {
    seq: bigint("seq", { mode: "bigint" }).primaryKey(),
    txHash: bytea("tx_hash").notNull().unique(),
    sender: bytea("sender").notNull(),
    nonce: bigint("tx_nonce", { mode: "bigint" }).notNull(),
    rawTx: bytea("raw_tx").notNull(),
    receivedAtMs: bigint("received_at_ms", { mode: "bigint" }).notNull(),
    prevHash: bytea("prev_hash").notNull(),
    entryHash: bytea("entry_hash").notNull(),
    signature: bytea("signature").notNull(),
    source: text("source", { enum: ["raw", "relay", "system"] }).notNull(),
    vaspId: integer("vasp_id"),
    forwardStatus: text("forward_status", {
      enum: ["queued", "forwarded", "rejected", "held_demo"],
    })
      .notNull()
      .default("queued"),
    forwardError: text("forward_error"),
    forwardedAt: timestamp("forwarded_at", { withTimezone: true }),
    includedBlock: bigint("included_block", { mode: "bigint" }),
    includedIndex: integer("included_index"),
  },
  (row) => [
    index("log_entries_sender_nonce").on(row.sender, row.nonce),
    index("log_entries_status_seq").on(row.forwardStatus, row.seq),
    index("log_entries_included_block").on(row.includedBlock),
    index("log_entries_forwarded_unobserved")
      .on(row.seq)
      .where(
        sql`${row.includedBlock} is null and ${row.forwardStatus} = 'forwarded'`,
      ),

    check(
      "log_entries_binary_sizes",
      sql`
      octet_length(${row.txHash}) = 32 and octet_length(${row.sender}) = 20
      and octet_length(${row.prevHash}) = 32 and octet_length(${row.entryHash}) = 32
      and octet_length(${row.signature}) = 65
    `,
    ),
  ],
);

export const rejections = gateway.table("rejections", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  source: text("source", { enum: ["raw", "relay", "system"] }).notNull(),
  sender: bytea("sender"),
  txHash: bytea("tx_hash"),
  reason: text("reason").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
});

export const relayRequests = gateway.table(
  "relay_requests",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    seq: bigint("seq", { mode: "bigint" })
      .notNull()
      .references(() => logEntries.seq),
    vaspId: integer("vasp_id").notNull(),
    requestFrom: bytea("request_from").notNull(),
    requestTo: bytea("request_to").notNull(),
    selector: bytea("selector").notNull(),
    nonce: numeric("forwarder_nonce", {
      precision: 78,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    digest: bytea("request_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (row) => [
    index("relay_requests_seq").on(row.seq),
    index("relay_requests_nonce").on(row.requestFrom, row.nonce),
  ],
);

export const trackedBlocks = gateway.table("tracked_blocks", {
  number: bigint("block_number", { mode: "bigint" }).primaryKey(),
  hash: bytea("block_hash").notNull(),
});

export const commitments = gateway.table("commitments", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  fromSeq: bigint("from_seq", { mode: "bigint" }).notNull(),
  toSeq: bigint("to_seq", { mode: "bigint" }).notNull(),
  headHash: bytea("head_hash").notNull(),
  txHash: bytea("tx_hash").notNull().unique(),
  blockNumber: bigint("block_number", { mode: "bigint" }),
  status: text("status", { enum: ["pending", "confirmed", "failed"] })
    .notNull()
    .default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const demoReorder = gateway.table("demo_reorder", {
  id: integer("id").primaryKey(),
  status: text("status", {
    enum: ["armed", "held", "completed", "expired"],
  }).notNull(),
  heldSeq: bigint("held_seq", { mode: "bigint" }),
  nextSeq: bigint("next_seq", { mode: "bigint" }),
  heldUntil: timestamp("held_until", { withTimezone: true }),
});
