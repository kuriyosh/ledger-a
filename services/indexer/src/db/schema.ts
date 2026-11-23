import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const indexer = pgSchema("indexer");
const bytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
const blockNumber = (name: string) => bigint(name, { mode: "bigint" });
const quantity = (name: string) =>
  numeric(name, { precision: 78, scale: 0, mode: "bigint" });

export const blocks = indexer.table("blocks", {
  number: blockNumber("number").primaryKey(),
  hash: bytes("hash").notNull(),
  parentHash: bytes("parent_hash").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  txCount: integer("tx_count").notNull(),
});

export const transactions = indexer.table(
  "transactions",
  {
    hash: bytes("hash").primaryKey(),
    blockNumber: blockNumber("block_number")
      .notNull()
      .references(() => blocks.number, { onDelete: "cascade" }),
    txIndex: integer("tx_index").notNull(),
    type: smallint("type").notNull(),
    fromAddress: bytes("from_address").notNull(),
    toAddress: bytes("to_address"),
    value: quantity("value").notNull(),
    nonce: blockNumber("nonce").notNull(),
    gasLimit: blockNumber("gas_limit").notNull(),
    gasUsed: blockNumber("gas_used").notNull(),
    status: smallint("status").notNull(),
    kind: text("kind").notNull(),
    input: bytes("input").notNull(),
    decodedCall: jsonb("decoded_call"),
    failureKind: text("failure_kind"),
    failureDetail: jsonb("failure_detail"),
    mint: quantity("mint"),
  },
  (row) => [
    uniqueIndex("transactions_position").on(row.blockNumber, row.txIndex),
    index("transactions_sender").on(row.fromAddress, row.blockNumber),
    index("transactions_recipient").on(row.toAddress, row.blockNumber),
  ],
);

export const logs = indexer.table(
  "logs",
  {
    blockNumber: blockNumber("block_number")
      .notNull()
      .references(() => blocks.number, { onDelete: "cascade" }),
    txHash: bytes("tx_hash")
      .notNull()
      .references(() => transactions.hash, { onDelete: "cascade" }),
    logIndex: integer("log_index").notNull(),
    address: bytes("address").notNull(),
    topic0: bytes("topic0"),
    topic1: bytes("topic1"),
    topic2: bytes("topic2"),
    topic3: bytes("topic3"),
    data: bytes("data").notNull(),
  },
  (row) => [
    primaryKey({ columns: [row.blockNumber, row.logIndex] }),
    index("logs_transaction").on(row.txHash, row.logIndex),
  ],
);

export const chainStatus = indexer.table(
  "chain_status",
  {
    id: smallint("id").primaryKey().default(1),
    startBlock: blockNumber("start_block").notNull(),
    indexedBlock: blockNumber("indexed_block").notNull(),
    unsafeBlock: blockNumber("unsafe_block"),
    safeBlock: blockNumber("safe_block"),
    finalizedBlock: blockNumber("finalized_block"),
    enforcementEnabled: boolean("enforcement_enabled").notNull().default(false),
    registryVersion: blockNumber("registry_version").notNull().default(sql`0`),
  },
  (row) => [check("chain_status_singleton", sql`${row.id} = 1`)],
);
