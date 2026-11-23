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
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { QuoteWire } from "../quote-model.ts";
import type { AttestationWire, TravelMessage } from "../travel-rule-model.ts";

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
    forwardNonce: numeric("forward_nonce", {
      precision: 78,
      scale: 0,
      mode: "bigint",
    }),
    forwardFirstBlock: bigint("forward_first_block", { mode: "bigint" }),
    gatewayTxHash: bytes("gateway_tx_hash"),
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

export const travelRuleMessages = pgTable(
  "travel_rule_messages",
  {
    refId: bytes("ref_id").primaryKey(),
    direction: text("direction", { enum: ["out", "in"] }).notNull(),
    counterpartyVaspId: integer("counterparty_vasp_id").notNull(),
    payload: jsonb("payload").$type<TravelMessage>().notNull(),
    status: text("status", {
      enum: ["pending", "approved", "rejected", "expired"],
    }).notNull(),
    nameMatch: boolean("name_match"),
    attestation: jsonb("attestation").$type<AttestationWire>(),
    signature: bytes("signature"),
    txHash: bytes("tx_hash"),
    deliveredAt: instant("delivered_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    decidedAt: instant("decided_at"),
  },
  (row) => [
    index("travel_rule_direction_status").on(
      row.direction,
      row.status,
      row.createdAt,
    ),
  ],
);

export const swaps = pgTable(
  "swaps",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    quoteHash: bytes("quote_hash").notNull().unique(),
    quote: jsonb("quote").$type<QuoteWire>().notNull(),
    makerSignature: bytes("maker_signature").notNull(),
    status: text("status", {
      enum: ["quoted", "submitted", "confirmed", "failed", "expired"],
    }).notNull(),
    allowExpired: boolean("allow_expired").notNull().default(false),
    txHash: bytes("tx_hash"),
    gatewayTxHash: bytes("gateway_tx_hash"),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    blockHash: bytes("block_hash"),
    gatewaySeq: bigint("gateway_seq", { mode: "bigint" }),
    firstGatewaySeq: bigint("first_gateway_seq", { mode: "bigint" }),
    forwardNonce: numeric("forward_nonce", {
      precision: 78,
      scale: 0,
      mode: "bigint",
    }),
    forwardFirstBlock: bigint("forward_first_block", { mode: "bigint" }),
    forwardRequests:
      jsonb("forward_requests").$type<
        Array<{
          from: `0x${string}`;
          to: `0x${string}`;
          value: string;
          gas: string;
          data: `0x${string}`;
          deadline: number;
          signature: `0x${string}`;
        }>
      >(),
    simulationError: text("simulation_error"),
    errorCode: text("error_code"),
    revision: integer("revision").notNull().default(0),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (row) => [
    index("swaps_customer_date").on(row.customerId, row.createdAt),
    index("swaps_block").on(row.blockNumber),
    index("swaps_pending").on(row.id).where(sql`${row.status} = 'submitted'`),
  ],
);

export const quotesIssued = pgTable("quotes_issued", {
  nonce: numeric("nonce", {
    precision: 78,
    scale: 0,
    mode: "bigint",
  }).primaryKey(),
  quote: jsonb("quote").$type<QuoteWire>().notNull(),
  signature: bytes("signature").notNull(),
  quoteHash: bytes("quote_hash").notNull().unique(),
  requestDigest: bytes("request_digest").notNull().unique(),
  requestedByVaspId: integer("requested_by_vasp_id").notNull(),
  expiresAt: instant("expires_at").notNull(),
  filledTxHash: bytes("filled_tx_hash"),
  filledBlockNumber: bigint("filled_block_number", { mode: "bigint" }),
});

export const disclosureRequests = pgTable(
  "disclosure_requests",
  {
    id: text("id").primaryKey(),
    address: bytes("address").notNull(),
    requestedBy: text("requested_by", { enum: ["auditor"] }).notNull(),
    reason: text("reason").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "rejected"],
    }).notNull(),
    disclosure: jsonb("disclosure").$type<{
      address: `0x${string}`;
      customerIdentification: string;
      name: { primaryIdentifier: string; secondaryIdentifier: string };
    }>(),
    createdAt: instant("created_at").notNull().defaultNow(),
    decidedAt: instant("decided_at"),
  },
  (row) => [index("disclosures_created").on(row.createdAt, row.id)],
);

export const amlChecked = pgTable(
  "aml_checked_transfers",
  {
    transferId: text("transfer_id")
      .notNull()
      .references(() => transfers.id),
    revision: integer("revision").notNull(),
  },
  (row) => [primaryKey({ columns: [row.transferId, row.revision] })],
);

export const alerts = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    transferId: text("transfer_id")
      .notNull()
      .references(() => transfers.id),
    transferRevision: integer("transfer_revision").notNull(),
    address: bytes("address").notNull(),
    rule: text("rule", { enum: ["LARGE_AMOUNT", "WATCHLIST"] }).notNull(),
    detail: jsonb("detail")
      .$type<{ token: "tUSD" | "tJPY"; amount: string }>()
      .notNull(),
    status: text("status", {
      enum: ["open", "freeze_requested", "frozen", "closed", "invalidated"],
    }).notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    blockHash: bytes("block_hash").notNull(),
    reasonId: bytes("reason_id").unique(),
    requestTimestamp: bigint("request_timestamp", { mode: "number" }),
    proposalId: text("proposal_id"),
    evidenceReorged: boolean("evidence_reorged").notNull().default(false),
    withdrawalSentAt: instant("withdrawal_sent_at"),
    proposalSettled: boolean("proposal_settled").notNull().default(false),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (row) => [
    uniqueIndex("alerts_transfer_rule").on(
      row.transferId,
      row.transferRevision,
      row.rule,
    ),
    index("alerts_status").on(row.status, row.id),
  ],
);
