import { randomUUID } from "node:crypto";
import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getAddress, type Hex } from "viem";
import type { ProposalInput } from "../proposals.ts";
import type { Approval, MemberId, SafeCall } from "../safe.ts";
import { approvals, pendingActions, proposals } from "./schema.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type Query = Pick<Database, "select" | "insert" | "update" | "delete">;
type Proposal = typeof proposals.$inferSelect;
export type ProposalStatus = Proposal["status"];
export type PendingAction = {
  proposalId: string;
  memberId: MemberId;
  action: "approve" | "execute";
  txHash: Hex;
  rawTx: Hex;
  firstBlock: bigint;
};
export type RequestedBy = { vaspId: number } | { memberId: MemberId };

const active = ["open", "executable", "failed", "cancelling"] as const;
const bytes = (value: Hex) => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

function entry(row: Proposal) {
  return {
    id: row.id,
    type: row.type,
    params: row.params,
    reason: row.reason,
    requestedBy:
      row.requestedByVaspId === null
        ? { memberId: row.requestedByMemberId }
        : { vaspId: row.requestedByVaspId },
    to: getAddress(hex(row.toAddress)),
    data: hex(row.data),
    safeNonce: row.safeNonce,
    safeTxHash: hex(row.safeTxHash),
    firstBlock: row.firstBlock,
    status: row.status,
    executedTxHash: row.executedTxHash && hex(row.executedTxHash),
    executedBlock: row.executedBlock,
    failedTxHash: row.failedTxHash && hex(row.failedTxHash),
    createdAt: row.createdAt,
  };
}

export type StoredProposal = ReturnType<typeof entry>;

export class ConsortiumRows {
  private readonly db: Query;

  constructor(db: Query) {
    this.db = db;
  }

  async listing(status?: ProposalStatus) {
    return (
      await this.db
        .select()
        .from(proposals)
        .where(status && eq(proposals.status, status))
        .orderBy(desc(proposals.createdAt), asc(proposals.id))
    ).map(entry);
  }

  async proposal(id: string) {
    const [row] = await this.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, id));
    if (!row)
      throw new ServiceError(
        "PROPOSAL_NOT_FOUND",
        "Proposal does not exist",
        404,
      );
    return entry(row);
  }

  async byRequestDigest(digest: Hex) {
    const [row] = await this.db
      .select()
      .from(proposals)
      .where(eq(proposals.requestDigest, bytes(digest)));
    return row && entry(row);
  }

  async watched() {
    return (
      await this.db
        .select({ id: proposals.id })
        .from(proposals)
        .where(
          or(
            inArray(proposals.status, active),
            and(
              eq(proposals.status, "executed"),
              eq(proposals.executionFinalized, false),
            ),
          ),
        )
        .orderBy(asc(proposals.safeNonce), asc(proposals.id))
    ).map(({ id }) => id);
  }

  async create(
    input: ProposalInput,
    requestedBy: RequestedBy,
    call: SafeCall,
    requestDigest: Hex | undefined,
    chain: {
      safeTxHash: Hex;
      safeNonce: bigint;
      firstBlock: bigint;
    },
  ) {
    const [open] = await this.db
      .select({ id: proposals.id })
      .from(proposals)
      .where(inArray(proposals.status, active))
      .limit(1);
    if (open)
      throw new ServiceError(
        "PROPOSAL_IN_PROGRESS",
        "An open proposal already exists",
        409,
      );
    const [inserted] = await this.db
      .insert(proposals)
      .values({
        id: `p_${randomUUID()}`,
        type: input.type,
        params: input.params,
        reason: input.reason,
        requestDigest: requestDigest && bytes(requestDigest),
        requestedByMemberId:
          "memberId" in requestedBy ? requestedBy.memberId : null,
        requestedByVaspId: "vaspId" in requestedBy ? requestedBy.vaspId : null,
        toAddress: bytes(call.to),
        data: bytes(call.data),
        safeNonce: chain.safeNonce,
        safeTxHash: bytes(chain.safeTxHash),
        firstBlock: chain.firstBlock,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted)
      throw new ServiceError(
        "DUPLICATE_PROPOSAL",
        "The Safe transaction already has a proposal",
        409,
      );
    return entry(inserted);
  }

  async approvals(id: string): Promise<Approval[]> {
    return (
      await this.db
        .select()
        .from(approvals)
        .where(eq(approvals.proposalId, id))
        .orderBy(asc(approvals.memberId))
    ).map((row) => ({
      memberId: row.memberId as MemberId,
      address: getAddress(hex(row.memberAddress)),
      txHash: hex(row.txHash),
      blockNumber: row.blockNumber,
      approvedAt: row.approvedAt,
    }));
  }

  async pending(id: string): Promise<PendingAction | undefined> {
    const [row] = await this.db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.proposalId, id));
    return (
      row && {
        proposalId: row.proposalId,
        memberId: row.memberId as MemberId,
        action: row.action,
        txHash: hex(row.txHash),
        rawTx: hex(row.rawTx),
        firstBlock: row.firstBlock,
      }
    );
  }

  async prepare(request: PendingAction) {
    await this.db.insert(pendingActions).values({
      ...request,
      txHash: bytes(request.txHash),
      rawTx: bytes(request.rawTx),
    });
  }

  async consume(request: PendingAction) {
    await this.db
      .delete(pendingActions)
      .where(
        and(
          eq(pendingActions.proposalId, request.proposalId),
          eq(pendingActions.txHash, bytes(request.txHash)),
        ),
      );
  }

  async record(
    id: string,
    state: {
      status: ProposalStatus;
      approvals: readonly Approval[];
      executed?: { txHash: Hex; blockNumber: bigint };
      executionFinalized: boolean;
      failedTxHash?: Hex;
    },
  ) {
    await this.db
      .update(proposals)
      .set({
        status: state.status,
        executedTxHash: state.executed ? bytes(state.executed.txHash) : null,
        executedBlock: state.executed?.blockNumber ?? null,
        executionFinalized: state.executionFinalized,
        failedTxHash: state.failedTxHash ? bytes(state.failedTxHash) : null,
        updatedAt: new Date(),
      })
      .where(eq(proposals.id, id));
    await this.db.delete(approvals).where(eq(approvals.proposalId, id));
    if (state.approvals.length > 0)
      await this.db.insert(approvals).values(
        state.approvals.map((item) => ({
          proposalId: id,
          memberId: item.memberId,
          memberAddress: bytes(item.address),
          txHash: bytes(item.txHash),
          blockNumber: item.blockNumber,
          approvedAt: item.approvedAt,
        })),
      );
  }
}

export class ConsortiumStore extends ConsortiumRows {
  private readonly database: Database;

  constructor(database: Database) {
    super(database);
    this.database = database;
  }

  lock<T>(operation: (rows: ConsortiumRows) => Promise<T>) {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('consortium:safe', 0))`,
      );
      return operation(new ConsortiumRows(transaction));
    });
  }
}
