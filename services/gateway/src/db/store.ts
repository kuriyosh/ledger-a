import type { openDatabase } from "@ledgera/shared/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  max,
  ne,
  sql,
} from "drizzle-orm";
import { bytesToHex, getAddress, type Hex } from "viem";
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
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('ledgerA Gateway receipt log'))`,
      );

      return await action({
        async history(sender, hash) {
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
          const [nonce] = await tx
            .select({ maximum: max(logEntries.nonce) })
            .from(logEntries)
            .where(
              and(
                eq(logEntries.sender, toBuffer(sender)),
                ne(logEntries.forwardStatus, "rejected"),
              ),
            );
          const [queue] = await tx
            .select({ queued: count() })
            .from(logEntries)
            .where(inArray(logEntries.forwardStatus, ["queued", "held_demo"]));

          return {
            head: lastEntry && head(lastEntry),
            duplicate: duplicate !== undefined,
            lastNonce: nonce.maximum ?? undefined,
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
    await this.db
      .update(logEntries)
      .set({
        forwardStatus: status,
        forwardError: error,
        forwardedAt: new Date(),
      })
      .where(
        and(eq(logEntries.seq, seq), eq(logEntries.forwardStatus, "queued")),
      );
  }
}
