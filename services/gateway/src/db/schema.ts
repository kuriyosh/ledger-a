import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  customType,
  index,
  integer,
  jsonb,
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (row) => [index("relay_requests_seq").on(row.seq)],
);
