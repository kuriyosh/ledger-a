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
    derivedBlock: blockNumber("derived_block"),
    unsafeBlock: blockNumber("unsafe_block"),
    safeBlock: blockNumber("safe_block"),
    finalizedBlock: blockNumber("finalized_block"),
    enforcementEnabled: boolean("enforcement_enabled").notNull().default(false),
    registryVersion: blockNumber("registry_version").notNull().default(sql`0`),
  },
  (row) => [check("chain_status_singleton", sql`${row.id} = 1`)],
);

const eventPosition = () => ({
  blockNumber: blockNumber("block_number")
    .notNull()
    .references(() => blocks.number, { onDelete: "cascade" }),
  logIndex: integer("log_index").notNull(),
  txHash: bytes("tx_hash")
    .notNull()
    .references(() => transactions.hash, { onDelete: "cascade" }),
});
const eventDetails = () => ({
  ...eventPosition(),
  event: text("event").notNull(),
  args: jsonb("args").$type<Record<string, unknown>>().notNull(),
});
const vaspId = () => blockNumber("vasp_id").notNull();

export const tokenTransfers = indexer.table(
  "token_transfers",
  {
    ...eventPosition(),
    token: bytes("token").notNull(),
    fromAddress: bytes("from_address").notNull(),
    toAddress: bytes("to_address").notNull(),
    amount: quantity("amount").notNull(),
    travelRuleRef: bytes("travel_rule_ref"),
  },
  (row) => [
    primaryKey({ columns: [row.blockNumber, row.logIndex] }),
    index("token_transfers_sender").on(
      row.fromAddress,
      row.blockNumber,
      row.logIndex,
    ),
    index("token_transfers_recipient").on(
      row.toAddress,
      row.blockNumber,
      row.logIndex,
    ),
    index("token_transfers_travel_rule").on(row.travelRuleRef),
  ],
);

export const balancesHistory = indexer.table(
  "balances_history",
  {
    blockNumber: blockNumber("block_number")
      .notNull()
      .references(() => blocks.number, { onDelete: "cascade" }),
    logIndex: integer("log_index").notNull(),
    token: bytes("token").notNull(),
    account: bytes("account").notNull(),
    balance: quantity("balance").notNull(),
  },
  (row) => [
    primaryKey({
      columns: [row.token, row.account, row.blockNumber, row.logIndex],
    }),
    index("balances_history_block").on(row.blockNumber),
  ],
);

export const registryAccountEvents = indexer.table(
  "registry_account_events",
  {
    ...eventPosition(),
    account: bytes("account").notNull(),
    vaspId: vaspId(),
    kind: smallint("kind").notNull(),
    status: smallint("status").notNull(),
    validUntil: numeric("valid_until", {
      precision: 20,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    version: blockNumber("version").notNull(),
    actor: bytes("actor").notNull(),
    reason: bytes("reason").notNull(),
  },
  (row) => [
    primaryKey({ columns: [row.blockNumber, row.logIndex] }),
    index("registry_account_history").on(
      row.account,
      row.blockNumber,
      row.logIndex,
    ),
  ],
);

export const registryVaspEvents = indexer.table(
  "registry_vasp_events",
  { ...eventDetails(), vaspId: vaspId() },
  (row) => [
    primaryKey({ columns: [row.blockNumber, row.logIndex] }),
    index("registry_vasp_history").on(
      row.vaspId,
      row.blockNumber,
      row.logIndex,
    ),
  ],
);

export const travelRuleAttestations = indexer.table(
  "travel_rule_attestations",
  { ...eventDetails(), refId: bytes("ref_id").notNull() },
  (row) => [
    primaryKey({ columns: [row.blockNumber, row.logIndex] }),
    index("travel_rule_attestations_ref").on(row.refId),
  ],
);

export const swaps = indexer.table(
  "swaps",
  {
    ...eventDetails(),
    maker: bytes("maker").notNull(),
    taker: bytes("taker").notNull(),
  },
  (row) => [
    primaryKey({ columns: [row.blockNumber, row.logIndex] }),
    index("swaps_maker").on(row.maker, row.blockNumber, row.logIndex),
    index("swaps_taker").on(row.taker, row.blockNumber, row.logIndex),
  ],
);

export const safeEvents = indexer.table(
  "safe_events",
  { ...eventDetails(), safeTxHash: bytes("safe_tx_hash").notNull() },
  (row) => [
    primaryKey({ columns: [row.blockNumber, row.logIndex] }),
    index("safe_events_hash").on(row.safeTxHash),
  ],
);

export const receiptCommitments = indexer.table(
  "receipt_commitments",
  eventDetails(),
  (row) => [primaryKey({ columns: [row.blockNumber, row.logIndex] })],
);

export const tokenAdminEvents = indexer.table(
  "token_admin_events",
  { ...eventDetails(), token: bytes("token").notNull() },
  (row) => [primaryKey({ columns: [row.blockNumber, row.logIndex] })],
);

export const registryCheckpoints = indexer.table("registry_checkpoints", {
  blockNumber: blockNumber("block_number")
    .primaryKey()
    .references(() => blocks.number, { onDelete: "cascade" }),
  enforcementEnabled: boolean("enforcement_enabled").notNull(),
  registryVersion: blockNumber("registry_version").notNull(),
});
