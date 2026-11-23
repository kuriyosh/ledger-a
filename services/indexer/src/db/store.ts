import type { openDatabase } from "@ledgera/shared/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { bytesToHex, type Hex } from "viem";
import type { ChainBlock, Finality } from "../rpc.ts";
import { blocks, chainStatus, logs, transactions } from "./schema.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Query = Database | Transaction;
export type Position = { number: bigint; hash: Hex };
const bytes = (value: Hex) => Buffer.from(value.slice(2), "hex");
const option = (value: Hex | null | undefined) =>
  value == null ? null : bytes(value);
const chainLock = sql`select pg_advisory_xact_lock(hashtextextended('indexer:block', 0))`;

async function tip(query: Query): Promise<Position | undefined> {
  const [row] = await query
    .select({ number: blocks.number, hash: blocks.hash })
    .from(blocks)
    .orderBy(desc(blocks.number))
    .limit(1);
  return row && { number: row.number, hash: bytesToHex(row.hash) };
}

function same(left: Position | undefined, right: Position | undefined) {
  return left?.number === right?.number && left?.hash === right?.hash;
}

export class IndexerStore {
  private readonly db: Database;
  private readonly start: bigint;

  constructor(database: Database, start: bigint) {
    this.db = database;
    this.start = start;
  }

  async initialize() {
    await this.db.transaction(async (tx) => {
      await tx.execute(chainLock);
      await tx
        .insert(chainStatus)
        .values({ startBlock: this.start, indexedBlock: this.start - 1n })
        .onConflictDoNothing();
      const [existing] = await tx
        .select()
        .from(chainStatus)
        .where(eq(chainStatus.id, 1));
      if (existing?.startBlock !== this.start)
        throw new Error(
          "Indexer start block differs from the stored scan range",
        );
    });
  }

  tip() {
    return tip(this.db);
  }

  async blockAt(number: bigint): Promise<Position | undefined> {
    const [row] = await this.db
      .select({ hash: blocks.hash })
      .from(blocks)
      .where(eq(blocks.number, number));
    return row && { number, hash: bytesToHex(row.hash) };
  }

  async rewind(expected: Position, ancestor: bigint) {
    return this.db.transaction(async (tx) => {
      await tx.execute(chainLock);
      if (!same(await tip(tx), expected)) return false;
      await tx.delete(blocks).where(gt(blocks.number, ancestor));
      await tx
        .update(chainStatus)
        .set({
          indexedBlock: ancestor,
          unsafeBlock: null,
          safeBlock: null,
          finalizedBlock: null,
        })
        .where(eq(chainStatus.id, 1));
      return true;
    });
  }

  async append(expected: Position | undefined, block: ChainBlock) {
    return this.db.transaction(async (tx) => {
      await tx.execute(chainLock);
      if (!same(await tip(tx), expected)) return false;
      if (
        block.number !== (expected?.number ?? this.start - 1n) + 1n ||
        (expected && block.parentHash !== expected.hash)
      )
        throw new Error("Block does not continue the indexed chain");

      await tx.insert(blocks).values({
        number: block.number,
        hash: bytes(block.hash),
        parentHash: bytes(block.parentHash),
        timestamp: new Date(Number(block.timestamp) * 1_000),
        txCount: block.transactions.length,
      });

      const entries = block.transactions.map((item) => ({
        hash: bytes(item.hash),
        blockNumber: block.number,
        txIndex: item.transactionIndex,
        type: item.type,
        fromAddress: bytes(item.from),
        toAddress: option(item.to),
        value: item.value,
        nonce: item.nonce ?? 0n,
        gasLimit: item.gas,
        gasUsed: item.receipt.gasUsed,
        status: item.receipt.status,
        kind:
          item.type === 126
            ? "DEPOSIT"
            : item.to === null
              ? "CONTRACT_DEPLOY"
              : "OTHER",
        input: bytes(item.input),
        mint: item.mint ?? null,
      }));
      const events = block.transactions.flatMap((item) =>
        item.receipt.logs.map((log) => ({
          blockNumber: block.number,
          txHash: bytes(item.hash),
          logIndex: log.logIndex,
          address: bytes(log.address),
          topic0: option(log.topics[0]),
          topic1: option(log.topics[1]),
          topic2: option(log.topics[2]),
          topic3: option(log.topics[3]),
          data: bytes(log.data),
        })),
      );
      for (let from = 0; from < entries.length; from += 500)
        await tx.insert(transactions).values(entries.slice(from, from + 500));
      for (let from = 0; from < events.length; from += 500)
        await tx.insert(logs).values(events.slice(from, from + 500));

      await tx
        .update(chainStatus)
        .set({ indexedBlock: block.number })
        .where(eq(chainStatus.id, 1));
      return true;
    });
  }

  async updateFinality(finality: Finality, expected: Position | undefined) {
    return this.db.transaction(async (tx) => {
      await tx.execute(chainLock);
      if (!same(await tip(tx), expected)) return false;
      await tx
        .update(chainStatus)
        .set({
          unsafeBlock: finality.unsafe,
          safeBlock: finality.safe,
          finalizedBlock: finality.finalized,
        })
        .where(
          and(
            eq(chainStatus.id, 1),
            eq(chainStatus.indexedBlock, expected?.number ?? this.start - 1n),
          ),
        );
      return true;
    });
  }
}
