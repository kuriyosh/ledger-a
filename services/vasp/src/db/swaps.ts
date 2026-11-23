import { randomUUID } from "node:crypto";
import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { bytesToHex, type Hex } from "viem";
import type { QuoteWire } from "../quote-model.ts";
import { quotesIssued, swaps } from "./schema.ts";
import { findWalletOperation, transferBytes, walletLock } from "./transfers.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
export type Swap = typeof swaps.$inferSelect;
type QuoteEntry = { quote: QuoteWire; signature: Hex };
type Change = Partial<
  Pick<
    typeof swaps.$inferInsert,
    | "status"
    | "txHash"
    | "gatewayTxHash"
    | "blockNumber"
    | "blockHash"
    | "gatewaySeq"
    | "firstGatewaySeq"
    | "forwardNonce"
    | "forwardFirstBlock"
    | "forwardRequests"
    | "simulationError"
    | "errorCode"
  >
>;
const missing = () =>
  new ServiceError("SWAP_NOT_FOUND", "Quote or swap not found", 404);

export class SwapStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async issue(entry: QuoteEntry, quoteHash: Hex, digest: Hex, vaspId: number) {
    const record = {
      nonce: BigInt(entry.quote.nonce),
      quote: entry.quote,
      signature: transferBytes(entry.signature),
      quoteHash: transferBytes(quoteHash),
      requestDigest: transferBytes(digest),
      requestedByVaspId: vaspId,
      expiresAt: new Date(entry.quote.expiry * 1000),
    };
    const [inserted] = await this.db
      .insert(quotesIssued)
      .values(record)
      .onConflictDoNothing({ target: quotesIssued.requestDigest })
      .returning();
    if (inserted) return entry;
    const [previous] = await this.db
      .select()
      .from(quotesIssued)
      .where(eq(quotesIssued.requestDigest, record.requestDigest));
    if (!previous) throw new Error("Issued quote is missing");
    return { quote: previous.quote, signature: bytesToHex(previous.signature) };
  }

  async quote(customerId: string, received: QuoteEntry, digest: Hex) {
    const id = `q_${randomUUID().replaceAll("-", "")}`;
    const quoteHash = transferBytes(digest);
    const [created] = await this.db
      .insert(swaps)
      .values({
        id,
        customerId,
        quoteHash,
        quote: received.quote,
        makerSignature: transferBytes(received.signature),
        status: "quoted",
      })
      .onConflictDoNothing({ target: swaps.quoteHash })
      .returning({ id: swaps.id });
    if (created) return created.id;
    const [previous] = await this.db
      .select({ id: swaps.id })
      .from(swaps)
      .where(
        and(eq(swaps.customerId, customerId), eq(swaps.quoteHash, quoteHash)),
      );
    if (!previous) throw missing();
    return previous.id;
  }

  async list(customerId: string, limit: number) {
    return this.db
      .select()
      .from(swaps)
      .where(eq(swaps.customerId, customerId))
      .orderBy(desc(swaps.createdAt), desc(swaps.id))
      .limit(limit);
  }

  async get(customerId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(swaps)
      .where(and(eq(swaps.customerId, customerId), eq(swaps.id, id)));
    if (!row) throw missing();
    return row;
  }

  async submit(
    customerId: string,
    id: string,
    allowExpired: boolean,
    now: number,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(walletLock(customerId));
      const [row] = await tx
        .select()
        .from(swaps)
        .where(and(eq(swaps.customerId, customerId), eq(swaps.id, id)));
      if (!row) throw missing();
      if (row.status === "expired" && !allowExpired)
        throw new ServiceError("QUOTE_EXPIRED", "Quote has expired", 409);
      if (row.status !== "quoted" && row.status !== "expired") return row;
      if (!allowExpired && row.quote.expiry <= now)
        throw new ServiceError("QUOTE_EXPIRED", "Quote has expired", 409);
      const occupied = await findWalletOperation(tx, customerId);
      if (occupied)
        throw new ServiceError(
          "OPERATION_IN_PROGRESS",
          "A wallet operation is in progress",
          409,
          { id: occupied.id },
        );
      const [updated] = await tx
        .update(swaps)
        .set({
          status: "submitted",
          allowExpired,
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(swaps.id, id))
        .returning();
      return updated;
    });
  }

  async pending(after: string | undefined, limit: number) {
    return this.db
      .select()
      .from(swaps)
      .where(
        and(
          eq(swaps.status, "submitted"),
          after === undefined ? undefined : gt(swaps.id, after),
        ),
      )
      .orderBy(asc(swaps.id))
      .limit(limit);
  }

  async update(row: Swap, change: Change) {
    const [updated] = await this.db
      .update(swaps)
      .set({ ...change, revision: row.revision + 1, updatedAt: new Date() })
      .where(
        and(
          eq(swaps.id, row.id),
          eq(swaps.status, row.status),
          eq(swaps.revision, row.revision),
        ),
      )
      .returning();
    return updated as Swap | undefined;
  }

  async recordExpired(now: number) {
    await this.db
      .update(swaps)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        and(
          eq(swaps.status, "quoted"),
          sql`(${swaps.quote}->>'expiry')::bigint <= ${now}`,
        ),
      );
  }
}
