import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const bytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
const instant = (name: string) => timestamp(name, { withTimezone: true });
export const customerNumber = pgSequence("customer_number_seq");

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  familyName: text("family_name").notNull(),
  givenName: text("given_name").notNull(),
  dateOfBirth: date("date_of_birth").notNull(),
  country: text("country").notNull(),
  addressLine: text("address_line").notNull(),
  email: text("email").notNull().unique(),
  kycStatus: text("kyc_status", {
    enum: ["pending", "approved", "rejected", "error"],
  })
    .notNull()
    .default("pending"),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});

export const wallets = pgTable("wallets", {
  customerId: text("customer_id")
    .primaryKey()
    .references(() => customers.id),
  address: bytes("address").notNull().unique(),
  encryptedPrivateKey: bytes("encrypted_private_key").notNull(),
  registeredTxHash: bytes("registered_tx_hash"),
  registeredBlockNumber: bigint("registered_block_number", { mode: "bigint" }),
  registeredBlockHash: bytes("registered_block_hash"),
  validUntil: instant("valid_until").notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: bytes("token_hash").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    expiresAt: instant("expires_at").notNull(),
  },
  (row) => [index("sessions_expiry").on(row.expiresAt)],
);

export const registryRequests = pgTable("registry_requests", {
  customerId: text("customer_id")
    .primaryKey()
    .references(() => customers.id),
  action: text("action", {
    enum: ["register", "suspend", "reinstate"],
  }).notNull(),
  txHash: bytes("tx_hash").notNull().unique(),
  rawTx: bytes("raw_tx").notNull(),
  firstBlock: bigint("first_block", { mode: "bigint" }),
  createdAt: instant("created_at").notNull().defaultNow(),
});

export const transfers = pgTable(
  "transfers",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    direction: text("direction", { enum: ["out", "in"] }).notNull(),
    counterpartyAddress: bytes("counterparty_address").notNull(),
    counterpartyVaspId: integer("counterparty_vasp_id"),
    token: bytes("token").notNull(),
    amount: numeric("amount", {
      precision: 78,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    status: text("status", {
      enum: [
        "created",
        "tr_pending",
        "tr_approved",
        "submitted",
        "confirmed",
        "tr_rejected",
        "tr_expired",
        "failed",
        "reorged",
      ],
    }).notNull(),
    beneficiaryName: jsonb("beneficiary_name").$type<{
      primaryIdentifier: string;
      secondaryIdentifier: string;
    }>(),
    refId: bytes("ref_id"),
    txHash: bytes("tx_hash"),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    blockHash: bytes("block_hash"),
    logIndex: integer("log_index"),
    gatewaySeq: bigint("gateway_seq", { mode: "bigint" }),
    revision: integer("revision").notNull().default(0),
    forwardRequest: jsonb("forward_request").$type<{
      from: `0x${string}`;
      to: `0x${string}`;
      value: string;
      gas: string;
      data: `0x${string}`;
      deadline: number;
      signature: `0x${string}`;
    }>(),
    firstGatewaySeq: bigint("first_gateway_seq", { mode: "bigint" }),
    submitOnRevert: boolean("submit_on_revert").notNull().default(false),
    skipChecks: boolean("skip_checks").notNull().default(false),
    simulationError: text("simulation_error"),
    errorCode: text("error_code"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (row) => [
    index("transfers_customer_created").on(row.customerId, row.createdAt),
    index("transfers_inclusion").on(row.blockNumber),
    index("transfers_work_queue").on(row.status, row.createdAt),
    uniqueIndex("incoming_transfer_occurrence")
      .on(row.txHash, row.blockHash, row.logIndex, row.customerId)
      .where(sql`${row.direction} = 'in'`),
  ],
);

export const processedBlocks = pgTable("processed_blocks", {
  number: bigint("block_number", { mode: "bigint" }).primaryKey(),
  hash: bytes("block_hash").notNull(),
});
