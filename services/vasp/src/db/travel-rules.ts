import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { and, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { bytesToHex, type Hex } from "viem";
import type {
  AttestationWire,
  PeerReply,
  TravelMessage,
} from "../travel-rule-model.ts";
import { transfers, travelRuleMessages } from "./schema.ts";
import { type Transfer, transferBytes } from "./transfers.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type MessageRow = typeof travelRuleMessages.$inferSelect;
type Direction = MessageRow["direction"];
type Decision =
  | { status: "rejected" | "expired" }
  | { status: "approved"; attestation: AttestationWire; signature: Hex };

const unavailable = () =>
  new ServiceError(
    "TRAVEL_RULE_NOT_FOUND",
    "Travel Rule message does not exist",
    404,
  );

function decisionFields(decision: Decision) {
  return {
    status: decision.status,
    decidedAt: new Date(),
    attestation: decision.status === "approved" ? decision.attestation : null,
    signature:
      decision.status === "approved" ? transferBytes(decision.signature) : null,
  };
}

export function peerView(row: MessageRow): PeerReply {
  const refId = bytesToHex(row.refId);
  if (row.status === "approved") {
    if (!row.attestation || !row.signature)
      throw new Error("Travel Rule approval has no proof");
    return {
      refId,
      status: "approved",
      attestation: row.attestation,
      signature: bytesToHex(row.signature),
    };
  }
  return { refId, status: row.status === "pending" ? "pending" : "rejected" };
}

export class TravelRuleStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async message(refId: Hex, direction: Direction, peer?: number) {
    const [row] = await this.db
      .select()
      .from(travelRuleMessages)
      .where(
        and(
          eq(travelRuleMessages.refId, transferBytes(refId)),
          eq(travelRuleMessages.direction, direction),
          peer === undefined
            ? undefined
            : eq(travelRuleMessages.counterpartyVaspId, peer),
        ),
      );
    if (!row) throw unavailable();
    return row;
  }

  async inbox(
    input: TravelMessage,
    nameMatch: boolean | null,
    decision?: Decision,
  ) {
    const [inserted] = await this.db
      .insert(travelRuleMessages)
      .values({
        refId: transferBytes(input.refId),
        direction: "in",
        counterpartyVaspId: input.originatorVaspId,
        payload: input,
        nameMatch,
        status: "pending",
        ...(decision && decisionFields(decision)),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    const [recorded] = await this.db
      .select()
      .from(travelRuleMessages)
      .where(
        and(
          eq(travelRuleMessages.refId, transferBytes(input.refId)),
          eq(travelRuleMessages.direction, "in"),
          eq(travelRuleMessages.counterpartyVaspId, input.originatorVaspId),
          sql`${travelRuleMessages.payload} = ${JSON.stringify(input)}::jsonb`,
        ),
      );
    if (!recorded)
      throw new ServiceError(
        "TRAVEL_RULE_REF_CONFLICT",
        "Travel Rule reference already exists",
        409,
      );
    return recorded;
  }

  async decide(refId: Hex, decision: Decision) {
    const [changed] = await this.db
      .update(travelRuleMessages)
      .set(decisionFields(decision))
      .where(
        and(
          eq(travelRuleMessages.refId, transferBytes(refId)),
          eq(travelRuleMessages.direction, "in"),
          eq(travelRuleMessages.status, "pending"),
        ),
      )
      .returning();
    if (changed) return changed;
    const recorded = await this.message(refId, "in");
    if (recorded.status === decision.status) return recorded;
    throw new ServiceError(
      "TRAVEL_RULE_ALREADY_DECIDED",
      "Travel Rule message already has a decision",
      409,
    );
  }

  async listing(direction?: Direction) {
    const rows = await this.db
      .select()
      .from(travelRuleMessages)
      .where(
        direction ? eq(travelRuleMessages.direction, direction) : undefined,
      )
      .orderBy(desc(travelRuleMessages.createdAt));
    return rows.map((row) => ({
      ...peerView(row),
      status: row.status,
      message: row.payload,
      direction: row.direction,
      counterpartyVaspId: row.counterpartyVaspId,
      nameMatch: row.nameMatch,
      txHash: row.txHash && bytesToHex(row.txHash),
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
    }));
  }

  async begin(row: Transfer, input: TravelMessage) {
    await this.db.transaction(async (tx) => {
      const [changed] = await tx
        .update(transfers)
        .set({
          status: "tr_pending",
          refId: transferBytes(input.refId),
          counterpartyVaspId: input.beneficiaryVaspId,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(transfers.id, row.id),
            eq(transfers.status, "created"),
            eq(transfers.revision, row.revision),
          ),
        )
        .returning({ id: transfers.id });
      if (!changed) return;
      await tx.insert(travelRuleMessages).values({
        refId: transferBytes(input.refId),
        direction: "out",
        counterpartyVaspId: input.beneficiaryVaspId,
        payload: input,
        status: "pending",
      });
    });
  }

  async advance(row: Transfer, refId: Hex, decision?: Decision) {
    await this.db.transaction(async (tx) => {
      if (decision) {
        const state = {
          approved: "tr_approved",
          rejected: "tr_rejected",
          expired: "tr_expired",
        } as const;
        const [changed] = await tx
          .update(transfers)
          .set({
            status: state[decision.status],
            revision: row.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(transfers.id, row.id),
              eq(transfers.status, row.status),
              eq(transfers.revision, row.revision),
              eq(transfers.refId, transferBytes(refId)),
            ),
          )
          .returning({ id: transfers.id });
        if (!changed) return;
      }
      await tx
        .update(travelRuleMessages)
        .set({
          deliveredAt: decision?.status === "expired" ? undefined : new Date(),
          ...(decision && decisionFields(decision)),
        })
        .where(
          and(
            eq(travelRuleMessages.refId, transferBytes(refId)),
            eq(travelRuleMessages.direction, "out"),
          ),
        );
    });
  }

  async expireInbox(now: number) {
    await this.db
      .update(travelRuleMessages)
      .set({ status: "expired", decidedAt: new Date() })
      .where(
        and(
          eq(travelRuleMessages.direction, "in"),
          eq(travelRuleMessages.status, "pending"),
          sql`(${travelRuleMessages.payload}->>'expiry')::bigint <= ${now}`,
        ),
      );
  }

  async unreported() {
    return this.db
      .select({
        refId: travelRuleMessages.refId,
        peer: travelRuleMessages.counterpartyVaspId,
        hash: transfers.txHash,
      })
      .from(travelRuleMessages)
      .innerJoin(transfers, eq(transfers.refId, travelRuleMessages.refId))
      .where(
        and(
          eq(travelRuleMessages.direction, "out"),
          eq(travelRuleMessages.status, "approved"),
          eq(transfers.direction, "out"),
          eq(transfers.status, "confirmed"),
          isNotNull(transfers.txHash),
          or(
            isNull(travelRuleMessages.txHash),
            ne(travelRuleMessages.txHash, transfers.txHash),
          ),
        ),
      )
      .limit(20);
  }

  async hasIncoming(refId: Hex, hash: Hex) {
    const [seen] = await this.db
      .select({ id: transfers.id })
      .from(transfers)
      .where(
        and(
          eq(transfers.refId, transferBytes(refId)),
          eq(transfers.txHash, transferBytes(hash)),
          eq(transfers.direction, "in"),
          eq(transfers.status, "confirmed"),
        ),
      )
      .limit(1);
    return !!seen;
  }

  async recordHash(refId: Hex, direction: Direction, hash: Hex) {
    await this.db
      .update(travelRuleMessages)
      .set({ txHash: transferBytes(hash) })
      .where(
        and(
          eq(travelRuleMessages.refId, transferBytes(refId)),
          eq(travelRuleMessages.direction, direction),
          eq(travelRuleMessages.status, "approved"),
        ),
      );
  }
}
