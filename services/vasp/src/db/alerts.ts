import { randomBytes, randomUUID } from "node:crypto";
import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { and, asc, desc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { bytesToHex, getAddress } from "viem";
import type { AlertRule, TokenSymbol } from "../aml-rules.ts";
import { alerts, amlChecked, customers, transfers, wallets } from "./schema.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type Row = typeof alerts.$inferSelect;
const missing = () =>
  new ServiceError("ALERT_NOT_FOUND", "Alert does not exist", 404);
const noEvidence = () =>
  new ServiceError(
    "ALERT_EVIDENCE_REMOVED",
    "The incoming transfer is no longer verifiable",
    409,
  );

export function alertView(row: Row) {
  return {
    id: row.id,
    customerId: row.customerId,
    transferId: row.transferId,
    address: getAddress(bytesToHex(row.address)),
    rule: row.rule,
    detail: row.detail,
    status: row.status,
    blockNumber: row.blockNumber.toString(),
    blockHash: bytesToHex(row.blockHash),
    proposalId: row.proposalId,
    evidenceReorged: row.evidenceReorged,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class AlertStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  candidates(after: string | undefined, limit: number) {
    return this.db
      .select({
        id: transfers.id,
        customerId: transfers.customerId,
        amount: transfers.amount,
        token: transfers.token,
        from: transfers.counterpartyAddress,
        blockNumber: transfers.blockNumber,
        blockHash: transfers.blockHash,
        address: wallets.address,
        familyName: customers.familyName,
        givenName: customers.givenName,
      })
      .from(transfers)
      .leftJoin(amlChecked, eq(amlChecked.transferId, transfers.id))
      .innerJoin(customers, eq(customers.id, transfers.customerId))
      .innerJoin(wallets, eq(wallets.customerId, transfers.customerId))
      .where(
        and(
          eq(transfers.direction, "in"),
          eq(transfers.status, "confirmed"),
          isNull(amlChecked.transferId),
          after === undefined ? undefined : gt(transfers.id, after),
        ),
      )
      .orderBy(asc(transfers.id))
      .limit(limit);
  }

  async evaluated(
    candidate: Awaited<ReturnType<AlertStore["candidates"]>>[number],
    symbol: TokenSymbol,
    findings: AlertRule[],
  ) {
    const {
      id: transferId,
      blockNumber,
      blockHash,
      address,
      amount,
      customerId,
    } = candidate;
    if (blockNumber === null || !blockHash)
      throw new Error("Incoming transfer has no block position");
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: transfers.id })
        .from(transfers)
        .where(
          and(eq(transfers.id, transferId), eq(transfers.status, "confirmed")),
        )
        .for("update");
      if (!current) return;
      const [marked] = await tx
        .insert(amlChecked)
        .values({ transferId })
        .onConflictDoNothing()
        .returning();
      if (!marked || !findings.length) return;
      await tx.insert(alerts).values(
        findings.map((rule) => ({
          id: `a_${randomUUID().replaceAll("-", "")}`,
          transferId,
          customerId,
          blockNumber,
          blockHash,
          address,
          rule,
          detail: { token: symbol, amount: amount.toString() },
          status: "open" as const,
        })),
      );
    });
  }

  async list(limit: number) {
    const entries = await this.db
      .select()
      .from(alerts)
      .orderBy(desc(alerts.createdAt), desc(alerts.id))
      .limit(limit);
    return entries.map(alertView);
  }

  async alert(id: string) {
    const [entry] = await this.db
      .select()
      .from(alerts)
      .where(eq(alerts.id, id));
    if (!entry) throw missing();
    return entry;
  }

  async prepare(id: string, timestamp: number) {
    return this.db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(alerts)
        .where(eq(alerts.id, id))
        .for("update");
      if (!entry) throw missing();
      if (entry.status === "invalidated") throw noEvidence();
      if (entry.status !== "open" || entry.reasonId) return entry;
      const [updated] = await tx
        .update(alerts)
        .set({
          reasonId: randomBytes(32),
          requestTimestamp: timestamp,
          updatedAt: new Date(),
        })
        .where(eq(alerts.id, id))
        .returning();
      return updated;
    });
  }

  async changeTimestamp(row: Row, timestamp: number) {
    const [updated] = await this.db
      .update(alerts)
      .set({ requestTimestamp: timestamp, updatedAt: new Date() })
      .where(
        and(
          eq(alerts.id, row.id),
          eq(alerts.status, "open"),
          isNull(alerts.proposalId),
        ),
      )
      .returning();
    return updated;
  }

  async attach(id: string, proposalId: string) {
    return this.db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(alerts)
        .where(eq(alerts.id, id))
        .for("update");
      if (!entry) throw missing();
      if (entry.proposalId) return entry;
      const [updated] = await tx
        .update(alerts)
        .set({
          proposalId,
          status: entry.status === "open" ? "freeze_requested" : entry.status,
          updatedAt: new Date(),
        })
        .where(eq(alerts.id, id))
        .returning();
      return updated;
    });
  }

  async close(id: string) {
    return this.db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(alerts)
        .where(eq(alerts.id, id))
        .for("update");
      if (!entry) throw missing();
      if (entry.status === "closed") return alertView(entry);
      if (entry.status !== "open" || entry.reasonId)
        throw new ServiceError(
          "ALERT_CANNOT_CLOSE",
          "Only an open alert without a freeze request can be closed",
          409,
        );
      const [updated] = await tx
        .update(alerts)
        .set({ status: "closed", updatedAt: new Date() })
        .where(eq(alerts.id, id))
        .returning();
      return alertView(updated);
    });
  }

  async watched(after: string | undefined, limit: number) {
    return this.db
      .select()
      .from(alerts)
      .where(
        and(
          after === undefined ? undefined : gt(alerts.id, after),
          isNotNull(alerts.reasonId),
          or(
            and(eq(alerts.status, "open"), isNull(alerts.proposalId)),
            eq(alerts.status, "freeze_requested"),
            eq(alerts.status, "frozen"),
            and(
              eq(alerts.status, "invalidated"),
              eq(alerts.proposalSettled, false),
            ),
          ),
        ),
      )
      .orderBy(asc(alerts.id))
      .limit(limit);
  }

  async status(row: Row, next: Row["status"], evidenceReorged: boolean) {
    await this.db
      .update(alerts)
      .set({ status: next, evidenceReorged, updatedAt: new Date() })
      .where(
        and(
          eq(alerts.id, row.id),
          eq(alerts.status, row.status),
          eq(alerts.evidenceReorged, row.evidenceReorged),
        ),
      );
  }

  async settled(id: string) {
    await this.db
      .update(alerts)
      .set({ proposalSettled: true, updatedAt: new Date() })
      .where(and(eq(alerts.id, id), eq(alerts.status, "invalidated")));
  }

  async withdrawn(id: string) {
    await this.db
      .update(alerts)
      .set({ withdrawalSentAt: new Date(), updatedAt: new Date() })
      .where(and(eq(alerts.id, id), eq(alerts.status, "invalidated")));
  }
}
