import type { openDatabase } from "@ledgera/shared/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  ne,
  sql,
} from "drizzle-orm";
import { bytesToHex, getAddress, type Hex, parseTransaction } from "viem";
import type {
  AdmissionRecord,
  AdmissionStore,
  IntakeTransaction,
  ReceiptHead,
  SignedReceipt,
} from "../domain/admission.ts";
import { logEntries, rejections } from "./schema.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type Entry = typeof logEntries.$inferSelect;
const receiptLock = sql`select pg_advisory_xact_lock(hashtext('ledgerA Gateway receipt log'))`;

const toBuffer = (hex: Hex) => Buffer.from(hex.slice(2), "hex");

function head(
  row: Pick<Entry, "seq" | "entryHash" | "receivedAtMs">,
): ReceiptHead {
  return {
    seq: row.seq,
    receivedAtMs: row.receivedAtMs,
    entryHash: bytesToHex(row.entryHash),
  };
}

function receipt(row: Entry): SignedReceipt {
  return {
    ...head(row),
    txHash: bytesToHex(row.txHash),
    sender: getAddress(bytesToHex(row.sender)),
    prevHash: bytesToHex(row.prevHash),
    signature: bytesToHex(row.signature),
  };
}

export function receiptJson(value: SignedReceipt) {
  return {
    ...value,
    seq: value.seq.toString(),
    receivedAtMs: value.receivedAtMs.toString(),
  };
}

function logEntryJson(row: Entry) {
  return {
    ...receiptJson(receipt(row)),
    rawTx: bytesToHex(row.rawTx),
    source: row.source,
    vaspId: row.vaspId,
    forwardStatus: row.forwardStatus,
    forwardError: row.forwardError,
    includedBlock: row.includedBlock?.toString() ?? null,
    includedIndex: row.includedIndex,
  };
}

export class GatewayStore implements AdmissionStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  serialize<T>(action: (store: IntakeTransaction) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.execute(receiptLock);

      return await action({
        async history(sender, hash, confirmedNonce) {
          const [lastEntry] = await tx
            .select({
              seq: logEntries.seq,
              receivedAtMs: logEntries.receivedAtMs,
              entryHash: logEntries.entryHash,
            })
            .from(logEntries)
            .orderBy(desc(logEntries.seq))
            .limit(1);
          const [duplicate] = await tx
            .select({ seq: logEntries.seq })
            .from(logEntries)
            .where(eq(logEntries.txHash, toBuffer(hash)))
            .limit(1);
          const pending = await tx
            .select({ nonce: logEntries.nonce, raw: logEntries.rawTx })
            .from(logEntries)
            .where(
              and(
                eq(logEntries.sender, toBuffer(sender)),
                ne(logEntries.forwardStatus, "rejected"),
                gte(logEntries.nonce, confirmedNonce),
              ),
            );
          const outstanding = pending.map((entry) => {
            const decoded = parseTransaction(bytesToHex(entry.raw));
            if (
              decoded.type !== "eip1559" ||
              decoded.gas === undefined ||
              decoded.maxFeePerGas === undefined
            ) {
              throw new Error("Invalid transaction in the receipt log");
            }
            return {
              nonce: entry.nonce,
              cost: decoded.gas * decoded.maxFeePerGas + (decoded.value ?? 0n),
            };
          });
          const [queue] = await tx
            .select({ queued: count() })
            .from(logEntries)
            .where(inArray(logEntries.forwardStatus, ["queued", "held_demo"]));

          return {
            head: lastEntry && head(lastEntry),
            duplicate: duplicate !== undefined,
            outstanding,
            queued: queue.queued,
          };
        },
        async append(record: AdmissionRecord) {
          await tx.insert(logEntries).values({
            ...record,
            txHash: toBuffer(record.txHash),
            sender: toBuffer(record.sender),
            rawTx: toBuffer(record.rawTx),
            prevHash: toBuffer(record.prevHash),
            entryHash: toBuffer(record.entryHash),
            signature: toBuffer(record.signature),
          });
        },
      });
    });
  }

  async reject(...[source, error, tx]: Parameters<AdmissionStore["reject"]>) {
    await this.db.insert(rejections).values({
      source,
      sender: tx && toBuffer(tx.sender),
      txHash: tx && toBuffer(tx.txHash),
      reason: error.code,
      detail: error.details,
    });
  }

  async log(from: bigint, limit: number) {
    const entries = await this.db
      .select()
      .from(logEntries)
      .where(gte(logEntries.seq, from))
      .orderBy(asc(logEntries.seq))
      .limit(limit);
    return entries.map(logEntryJson);
  }

  async head() {
    const [row] = await this.db
      .select()
      .from(logEntries)
      .orderBy(desc(logEntries.seq))
      .limit(1);
    return row && head(row);
  }

  async receipt(hash: Hex) {
    const [row] = await this.db
      .select()
      .from(logEntries)
      .where(eq(logEntries.txHash, toBuffer(hash)))
      .limit(1);
    return row && receipt(row);
  }

  async receipts(hashes: Hex[]) {
    if (!hashes.length) return [];
    const rows = await this.db
      .select()
      .from(logEntries)
      .where(inArray(logEntries.txHash, hashes.map(toBuffer)))
      .orderBy(asc(logEntries.seq));
    return rows.map((row) => receiptJson(receipt(row)));
  }

  async rejections(limit: number) {
    const rows = await this.db
      .select()
      .from(rejections)
      .orderBy(desc(rejections.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id.toString(),
      receivedAt: row.receivedAt.toISOString(),
      source: row.source,
      sender: row.sender ? getAddress(bytesToHex(row.sender)) : null,
      txHash: row.txHash ? bytesToHex(row.txHash) : null,
      reason: row.reason,
      detail: row.detail,
    }));
  }

  async queued() {
    const [row] = await this.db
      .select()
      .from(logEntries)
      .where(eq(logEntries.forwardStatus, "queued"))
      .orderBy(asc(logEntries.seq))
      .limit(1);
    return (
      row && {
        seq: row.seq,
        rawTx: bytesToHex(row.rawTx),
        sender: getAddress(bytesToHex(row.sender)),
        txHash: bytesToHex(row.txHash),
      }
    );
  }

  async forwardResult(seq: bigint) {
    const [row] = await this.db
      .select({
        status: logEntries.forwardStatus,
        error: logEntries.forwardError,
      })
      .from(logEntries)
      .where(eq(logEntries.seq, seq))
      .limit(1);
    return row;
  }

  async setForwardResult(
    seq: bigint,
    status: "forwarded" | "rejected",
    error: string | null,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(receiptLock);
      const [entry] = await tx
        .update(logEntries)
        .set({
          forwardStatus: status,
          forwardError: error,
          forwardedAt: new Date(),
        })
        .where(
          and(eq(logEntries.seq, seq), eq(logEntries.forwardStatus, "queued")),
        )
        .returning({
          seq: logEntries.seq,
          sender: logEntries.sender,
          nonce: logEntries.nonce,
        });
      if (!entry) return [];
      const results = [{ seq, status, error }];
      if (status === "forwarded") return results;

      const blocked = await tx
        .update(logEntries)
        .set({
          forwardStatus: "rejected",
          forwardError: "prior nonce rejected",
          forwardedAt: new Date(),
        })
        .where(
          and(
            eq(logEntries.sender, entry.sender),
            inArray(logEntries.forwardStatus, ["queued", "held_demo"]),
            gt(logEntries.nonce, entry.nonce),
            gt(logEntries.seq, entry.seq),
          ),
        )
        .returning({ seq: logEntries.seq });
      return results.concat(
        blocked.map(({ seq }) => ({
          seq,
          status: "rejected",
          error: "prior nonce rejected",
        })),
      );
    });
  }

  async firstReceipt() {
    const [row] = await this.db
      .select()
      .from(logEntries)
      .where(eq(logEntries.seq, 1n))
      .limit(1);
    return row && receipt(row);
  }
}
