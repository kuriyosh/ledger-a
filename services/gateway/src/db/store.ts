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
  isNull,
  lt,
  lte,
  ne,
  or,
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
import {
  commitments,
  demoReorder,
  logEntries,
  rejections,
  relayRequests,
  trackedBlocks,
} from "./schema.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type Entry = typeof logEntries.$inferSelect;
type StoreTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DemoState = typeof demoReorder.$inferSelect;
const demoId = 1;
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

async function demoState(
  db: Database | StoreTransaction,
): Promise<DemoState | undefined> {
  const [state] = await db
    .select()
    .from(demoReorder)
    .where(eq(demoReorder.id, demoId));
  return state;
}

async function releaseHeld(
  tx: StoreTransaction,
  state: DemoState,
  status: "completed" | "expired",
) {
  if (state.heldSeq !== null) {
    await tx
      .update(logEntries)
      .set({ forwardStatus: "queued" })
      .where(
        and(
          eq(logEntries.seq, state.heldSeq),
          eq(logEntries.forwardStatus, "held_demo"),
        ),
      );
  }
  await tx
    .update(demoReorder)
    .set({ status })
    .where(eq(demoReorder.id, demoId));
}

async function resolveDemo(tx: StoreTransaction, seq: bigint) {
  const state = await demoState(tx);
  if (state?.status === "held" && state.nextSeq === seq) {
    await releaseHeld(tx, state, "completed");
  }
}

async function takeDemoSlot(tx: StoreTransaction, record: AdmissionRecord) {
  const state = await demoState(tx);
  if (state?.status === "armed") {
    await tx
      .update(demoReorder)
      .set({
        status: "held",
        heldSeq: record.seq,
        heldUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(demoReorder.id, demoId));
    return "held_demo";
  }
  if (
    state?.status === "held" &&
    state.heldSeq !== null &&
    state.nextSeq === null
  ) {
    const [held] = await tx
      .select({ sender: logEntries.sender })
      .from(logEntries)
      .where(eq(logEntries.seq, state.heldSeq));
    if (held && !held.sender.equals(toBuffer(record.sender))) {
      await tx
        .update(demoReorder)
        .set({ nextSeq: record.seq })
        .where(eq(demoReorder.id, demoId));
    }
  }
  return "queued";
}

export class GatewayStore implements AdmissionStore {
  private readonly db: Database;
  private readonly demoEnabled: boolean;

  constructor(db: Database, demoEnabled = false) {
    this.db = db;
    this.demoEnabled = demoEnabled;
  }

  serialize<T>(action: (store: IntakeTransaction) => Promise<T>) {
    const demoEnabled = this.demoEnabled;
    return this.db.transaction(async (tx) => {
      await tx.execute(receiptLock);

      return await action({
        async history(sender, confirmedNonce) {
          const [lastEntry] = await tx
            .select({
              seq: logEntries.seq,
              receivedAtMs: logEntries.receivedAtMs,
              entryHash: logEntries.entryHash,
            })
            .from(logEntries)
            .orderBy(desc(logEntries.seq))
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
            outstanding,
            queued: queue.queued,
          };
        },
        async hasReceipt(hash) {
          const [duplicate] = await tx
            .select({ seq: logEntries.seq })
            .from(logEntries)
            .where(eq(logEntries.txHash, toBuffer(hash)))
            .limit(1);
          return duplicate !== undefined;
        },
        async relayClaims(operations) {
          if (!operations.length) return [];
          const rows = await tx
            .select({
              txHash: logEntries.txHash,
              digest: relayRequests.digest,
              seq: logEntries.seq,
              status: logEntries.forwardStatus,
            })
            .from(relayRequests)
            .innerJoin(logEntries, eq(relayRequests.seq, logEntries.seq))
            .where(
              or(
                ...operations.map((operation) =>
                  and(
                    eq(relayRequests.requestFrom, toBuffer(operation.from)),
                    eq(relayRequests.nonce, operation.nonce),
                  ),
                ),
              ),
            );
          return rows.map((row) => ({
            txHash: bytesToHex(row.txHash),
            digest: bytesToHex(row.digest),
            seq: row.seq,
            rejected: row.status === "rejected",
          }));
        },
        async append({ operations, commitment, ...record }: AdmissionRecord) {
          await tx.insert(logEntries).values({
            ...record,
            txHash: toBuffer(record.txHash),
            sender: toBuffer(record.sender),
            rawTx: toBuffer(record.rawTx),
            prevHash: toBuffer(record.prevHash),
            entryHash: toBuffer(record.entryHash),
            signature: toBuffer(record.signature),
            forwardStatus:
              demoEnabled && record.source === "relay"
                ? await takeDemoSlot(tx, record)
                : "queued",
          });
          if (commitment) {
            await tx.insert(commitments).values({
              ...commitment,
              headHash: toBuffer(commitment.headHash),
              txHash: toBuffer(record.txHash),
            });
          }
          if (operations?.length && record.vaspId !== undefined) {
            const vaspId = record.vaspId;
            await tx.insert(relayRequests).values(
              operations.map((operation) => ({
                seq: record.seq,
                vaspId,
                requestFrom: toBuffer(operation.from),
                requestTo: toBuffer(operation.to),
                selector: toBuffer(operation.selector),
                nonce: operation.nonce,
                digest: toBuffer(operation.digest),
              })),
            );
          }
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

  async armDemo() {
    return this.db.transaction(async (tx) => {
      await tx.execute(receiptLock);
      const state = await demoState(tx);
      if (state?.status === "armed" || state?.status === "held") return false;
      const armed = {
        status: "armed",
        heldSeq: null,
        nextSeq: null,
        heldUntil: null,
      } as const;
      await tx
        .insert(demoReorder)
        .values({ id: demoId, ...armed })
        .onConflictDoUpdate({ target: demoReorder.id, set: armed });
      return true;
    });
  }

  async demoState() {
    const state = await demoState(this.db);
    return {
      status: state?.status ?? "idle",
      heldSeq: state?.heldSeq?.toString() ?? null,
      nextSeq: state?.nextSeq?.toString() ?? null,
      heldUntil: state?.heldUntil?.toISOString() ?? null,
    };
  }

  async disableDemo() {
    await this.db.transaction(async (tx) => {
      await tx.execute(receiptLock);
      const state = await demoState(tx);
      if (state?.status === "armed" || state?.status === "held") {
        await releaseHeld(tx, state, "expired");
      }
    });
  }

  async queued(now = new Date()) {
    async function select(
      db: Database | StoreTransaction,
      held?: { sender: Buffer; nonce: bigint },
    ) {
      const [row] = await db
        .select()
        .from(logEntries)
        .where(
          and(
            eq(logEntries.forwardStatus, "queued"),
            held &&
              or(
                ne(logEntries.sender, held.sender),
                lt(logEntries.nonce, held.nonce),
              ),
          ),
        )
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
    if (!this.demoEnabled) return select(this.db);
    return this.db.transaction(async (tx) => {
      await tx.execute(receiptLock);
      const state = await demoState(tx);
      if (
        state?.status !== "held" ||
        state.heldSeq === null ||
        !state.heldUntil
      )
        return select(tx);
      if (state.heldUntil <= now) {
        await releaseHeld(tx, state, "expired");
        return select(tx);
      }
      const [held] = await tx
        .select({ sender: logEntries.sender, nonce: logEntries.nonce })
        .from(logEntries)
        .where(
          and(
            eq(logEntries.seq, state.heldSeq),
            eq(logEntries.forwardStatus, "held_demo"),
          ),
        );
      if (!held) await releaseHeld(tx, state, "expired");
      return select(tx, held);
    });
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
      if (this.demoEnabled) await resolveDemo(tx, seq);
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
      if (this.demoEnabled) {
        for (const blockedEntry of blocked)
          await resolveDemo(tx, blockedEntry.seq);
      }
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

  async trackedTip(): Promise<{ number: bigint; hash: Hex } | undefined> {
    const [row] = await this.db
      .select()
      .from(trackedBlocks)
      .orderBy(desc(trackedBlocks.number))
      .limit(1);
    return row && { number: row.number, hash: bytesToHex(row.hash) };
  }

  async trackedBlock(
    number: bigint,
  ): Promise<{ number: bigint; hash: Hex } | undefined> {
    const [row] = await this.db
      .select()
      .from(trackedBlocks)
      .where(eq(trackedBlocks.number, number))
      .limit(1);
    return row && { number: row.number, hash: bytesToHex(row.hash) };
  }

  async recordBlock(number: bigint, hash: Hex, transactions: readonly Hex[]) {
    return this.db.transaction(async (tx) => {
      await tx.execute(receiptLock);
      await tx.insert(trackedBlocks).values({ number, hash: toBuffer(hash) });
      if (!transactions.length) return [];
      const positions = new Map(
        transactions.map((hash, index) => [hash.toLowerCase(), index]),
      );
      const matches = await tx
        .select({
          seq: logEntries.seq,
          txHash: logEntries.txHash,
          status: logEntries.forwardStatus,
        })
        .from(logEntries)
        .where(inArray(logEntries.txHash, transactions.map(toBuffer)));
      for (const match of matches) {
        await tx
          .update(logEntries)
          .set({
            includedBlock: number,
            forwardStatus: "forwarded",
            forwardError: null,
            forwardedAt: sql`coalesce(${logEntries.forwardedAt}, now())`,
            includedIndex: positions.get(
              bytesToHex(match.txHash).toLowerCase(),
            ),
          })
          .where(eq(logEntries.seq, match.seq));
        if (this.demoEnabled && match.status !== "forwarded")
          await resolveDemo(tx, match.seq);
      }
      return matches
        .filter((item) => item.status !== "forwarded")
        .map((item) => item.seq);
    });
  }

  async rewindBlocks(ancestor: bigint) {
    await this.db.transaction(async (tx) => {
      await tx.execute(receiptLock);
      await tx
        .update(logEntries)
        .set({
          includedBlock: null,
          includedIndex: null,
          forwardStatus: "queued",
          forwardError: null,
          forwardedAt: null,
        })
        .where(
          or(
            gt(logEntries.includedBlock, ancestor),
            and(
              isNull(logEntries.includedBlock),
              eq(logEntries.forwardStatus, "forwarded"),
            ),
          ),
        );
      await tx
        .update(commitments)
        .set({ status: "pending", blockNumber: null })
        .where(gt(commitments.blockNumber, ancestor));
      await tx.delete(trackedBlocks).where(gt(trackedBlocks.number, ancestor));
    });
  }

  async unobservedForwarded(
    after: bigint,
    forwardedBefore: Date,
    limit: number,
  ) {
    const rows = await this.db
      .select({ seq: logEntries.seq, txHash: logEntries.txHash })
      .from(logEntries)
      .where(
        and(
          gt(logEntries.seq, after),
          isNull(logEntries.includedBlock),
          eq(logEntries.forwardStatus, "forwarded"),
          lte(logEntries.forwardedAt, forwardedBefore),
        ),
      )
      .orderBy(asc(logEntries.seq))
      .limit(limit);
    return rows.map((row) => ({ ...row, txHash: bytesToHex(row.txHash) }));
  }

  async requeueUnobserved(sequences: bigint[]) {
    if (!sequences.length) return;
    await this.db.transaction(async (tx) => {
      await tx.execute(receiptLock);
      await tx
        .update(logEntries)
        .set({ forwardStatus: "queued", forwardedAt: null, forwardError: null })
        .where(
          and(
            inArray(logEntries.seq, sequences),
            isNull(logEntries.includedBlock),
            eq(logEntries.forwardStatus, "forwarded"),
          ),
        );
    });
  }

  async requeueAllUnobserved() {
    await this.db.transaction(async (tx) => {
      await tx.execute(receiptLock);
      await tx
        .update(logEntries)
        .set({ forwardStatus: "queued", forwardedAt: null, forwardError: null })
        .where(
          and(
            isNull(logEntries.includedBlock),
            eq(logEntries.forwardStatus, "forwarded"),
          ),
        );
    });
  }

  async pendingCommitment() {
    const [row] = await this.db
      .select({
        txHash: commitments.txHash,
        forwardStatus: logEntries.forwardStatus,
        includedBlock: logEntries.includedBlock,
        includedHash: trackedBlocks.hash,
      })
      .from(commitments)
      .innerJoin(logEntries, eq(commitments.txHash, logEntries.txHash))
      .leftJoin(
        trackedBlocks,
        eq(logEntries.includedBlock, trackedBlocks.number),
      )
      .where(eq(commitments.status, "pending"))
      .orderBy(asc(commitments.id))
      .limit(1);
    return (
      row && {
        txHash: bytesToHex(row.txHash),
        forwardStatus: row.forwardStatus,
        includedBlock: row.includedBlock,
        includedHash: row.includedHash && bytesToHex(row.includedHash),
      }
    );
  }

  async lastConfirmedSeq() {
    const [row] = await this.db
      .select({ toSeq: commitments.toSeq })
      .from(commitments)
      .where(eq(commitments.status, "confirmed"))
      .orderBy(desc(commitments.toSeq))
      .limit(1);
    return row?.toSeq ?? 0n;
  }

  async finishCommitment(
    hash: Hex,
    status: "confirmed" | "failed",
    blockNumber: bigint | null,
  ) {
    await this.db
      .update(commitments)
      .set({ status, blockNumber })
      .where(
        and(
          eq(commitments.txHash, toBuffer(hash)),
          eq(commitments.status, "pending"),
        ),
      );
  }

  async uncommittedHead(lastSeq: bigint) {
    const [outstanding] = await this.db
      .select({ seq: logEntries.seq })
      .from(logEntries)
      .where(and(gt(logEntries.seq, lastSeq), ne(logEntries.source, "system")))
      .limit(1);
    if (!outstanding) return undefined;
    return this.head();
  }

  async commitments(limit: number) {
    const rows = await this.db
      .select()
      .from(commitments)
      .orderBy(desc(commitments.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id.toString(),
      fromSeq: row.fromSeq.toString(),
      toSeq: row.toSeq.toString(),
      headHash: bytesToHex(row.headHash),
      txHash: bytesToHex(row.txHash),
      blockNumber: row.blockNumber?.toString() ?? null,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async queueLength() {
    const [{ queued }] = await this.db
      .select({ queued: count() })
      .from(logEntries)
      .where(inArray(logEntries.forwardStatus, ["queued", "held_demo"]));
    return queued;
  }
}
