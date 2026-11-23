import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const consortium = pgSchema("consortium");
const bytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
const instant = (name: string) => timestamp(name, { withTimezone: true });
const block = (name: string) => bigint(name, { mode: "bigint" });

export const proposals = consortium.table("proposals", {
  id: text("id").primaryKey(),
  type: text("type", {
    enum: [
      "BLOCK_ACCOUNT",
      "UNBLOCK_ACCOUNT",
      "REGISTER_VASP",
      "SET_VASP_STATUS",
      "REGISTER_OPERATOR_ACCOUNT",
      "RAW",
    ],
  }).notNull(),
  params: jsonb("params").notNull(),
  reason: text("reason").notNull(),
  requestDigest: bytes("request_digest").unique(),
  requestedByVaspId: integer("requested_by_vasp_id"),
  requestedByMemberId: integer("requested_by_member_id"),
  toAddress: bytes("to_address").notNull(),
  data: bytes("data").notNull(),
  safeNonce: block("safe_nonce").notNull(),
  safeTxHash: bytes("safe_tx_hash").notNull().unique(),
  status: text("status", {
    enum: [
      "open",
      "executable",
      "failed",
      "cancelling",
      "cancelled",
      "executed",
    ],
  })
    .notNull()
    .default("open"),
  firstBlock: block("first_block").notNull(),
  executedTxHash: bytes("executed_tx_hash"),
  executedBlock: block("executed_block"),
  executionFinalized: boolean("execution_finalized").notNull().default(false),
  failedTxHash: bytes("failed_tx_hash"),
  cancelSafeTxHash: bytes("cancel_safe_tx_hash"),
  cancelExecutedTxHash: bytes("cancel_executed_tx_hash"),
  cancelExecutedBlock: block("cancel_executed_block"),
  cancelExecutionPrepared: boolean("cancel_execution_prepared")
    .notNull()
    .default(false),
  cancelledLocally: boolean("cancelled_locally").notNull().default(false),
  originalApprovalPrepared: boolean("original_approval_prepared")
    .notNull()
    .default(false),
  cancelFailedTxHash: bytes("cancel_failed_tx_hash"),
  withdrawalRequestedAt: instant("withdrawal_requested_at"),
  withdrawalReason: text("withdrawal_reason"),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});

export const approvals = consortium.table(
  "approvals",
  {
    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposals.id),
    memberId: integer("member_id").notNull(),
    kind: text("kind", { enum: ["execute", "cancel"] })
      .notNull()
      .default("execute"),
    memberAddress: bytes("member_address").notNull(),
    txHash: bytes("tx_hash").notNull(),
    blockNumber: block("block_number").notNull(),
    approvedAt: instant("approved_at").notNull(),
  },
  (row) => [primaryKey({ columns: [row.proposalId, row.memberId, row.kind] })],
);

export const pendingActions = consortium.table("pending_actions", {
  proposalId: text("proposal_id")
    .primaryKey()
    .references(() => proposals.id),
  memberId: integer("member_id").notNull(),
  action: text("action", {
    enum: ["approve", "execute", "cancel_approve", "cancel_execute"],
  }).notNull(),
  txHash: bytes("tx_hash").notNull().unique(),
  rawTx: bytes("raw_tx").notNull(),
  firstBlock: block("first_block").notNull(),
  createdAt: instant("created_at").notNull().defaultNow(),
});
