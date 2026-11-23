import type { openDatabase } from "@ledgera/shared/db";
import { desc, eq, gt, sql } from "drizzle-orm";
import { bytesToHex, type Hex } from "viem";
import type { ChainBlock, Finality } from "../rpc.ts";
import {
  type Derived,
  indexDerived,
  prepareDerived,
  registryAtTip,
  storedEntries,
  verifyBalances,
} from "./derived.ts";
import { blocks, chainStatus, logs, transactions } from "./schema.ts";

export type IndexerDatabase = Awaited<ReturnType<typeof openDatabase>>["db"];
export type IndexerTransaction = Parameters<
  Parameters<IndexerDatabase["transaction"]>[0]
>[0];
type Query = IndexerDatabase | IndexerTransaction;
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
  private readonly db: IndexerDatabase;
  private readonly start: bigint;
  private readonly derived?: Derived;

  constructor(database: IndexerDatabase, start: bigint, derived?: Derived) {
    this.db = database;
    this.start = start;
    this.derived = derived;
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
      const [status] = await tx
        .select({ finalized: chainStatus.finalizedBlock })
        .from(chainStatus)
        .where(eq(chainStatus.id, 1));
      if (
        status?.finalized !== null &&
        status?.finalized !== undefined &&
        ancestor < status.finalized
      )
        throw new Error("L2 would roll back an indexed finalized block");
      await tx.delete(blocks).where(gt(blocks.number, ancestor));
      await tx
        .update(chainStatus)
        .set({
          indexedBlock: ancestor,
          derivedBlock: sql`case when ${chainStatus.derivedBlock} > ${ancestor} then ${ancestor} else ${chainStatus.derivedBlock} end`,
          ...(this.derived && (await registryAtTip(tx, ancestor))),
          unsafeBlock: null,
          safeBlock: null,
        })
        .where(eq(chainStatus.id, 1));
      return true;
    });
  }

  async backfill() {
    const derived = this.derived;
    if (!derived) return true;
    for (let remaining = 32; remaining > 0; --remaining) {
      const snapshot = await this.db.transaction(
        async (tx) => {
          const [status] = await tx
            .select()
            .from(chainStatus)
            .where(eq(chainStatus.id, 1));
          if (!status) throw new Error("Indexer chain status is missing");
          const next = (status.derivedBlock ?? this.start - 1n) + 1n;
          if (next > status.indexedBlock) return undefined;
          const [row] = await tx
            .select()
            .from(blocks)
            .where(eq(blocks.number, next));
          if (!row) throw new Error("Raw block is missing during backfill");
          return { next, row, status, raw: await storedEntries(tx, next) };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
      if (!snapshot) return true;
      const { next, row, status, raw } = snapshot;
      const block = {
        number: row.number,
        hash: bytesToHex(row.hash),
        parentHash: bytesToHex(row.parentHash),
      };
      const prepared = await prepareDerived(
        this.db,
        block,
        raw,
        this.start,
        derived,
      );
      const saved = await this.db.transaction(async (tx) => {
        await tx.execute(chainLock);
        const [current] = await tx
          .select()
          .from(chainStatus)
          .where(eq(chainStatus.id, 1));
        const [canonical] = await tx
          .select({ hash: blocks.hash })
          .from(blocks)
          .where(eq(blocks.number, next));
        if (
          !canonical?.hash.equals(row.hash) ||
          current?.derivedBlock !== status.derivedBlock
        )
          return false;
        await indexDerived(tx, block, prepared, this.start, derived);
        return true;
      });
      if (!saved) return false;
      await this.verify(block);
      if (next === status.indexedBlock) return true;
    }
    return false;
  }

  async append(expected: Position | undefined, block: ChainBlock) {
    const derived = this.derived;
    const prepared =
      derived &&
      (await prepareDerived(
        this.db,
        block,
        block.transactions.map((entry) => ({
          hash: bytes(entry.hash),
          transaction: { ...entry, logs: entry.receipt.logs },
        })),
        this.start,
        derived,
      ));
    const saved = await this.db.transaction(async (tx) => {
      await tx.execute(chainLock);
      if (!same(await tip(tx), expected)) return false;
      if (
        block.number !== (expected?.number ?? this.start - 1n) + 1n ||
        (expected && block.parentHash !== expected.hash)
      )
        throw new Error("Block does not continue the indexed chain");
      if (this.derived) {
        const [status] = await tx
          .select({ height: chainStatus.derivedBlock })
          .from(chainStatus)
          .where(eq(chainStatus.id, 1));
        if (!status || (status.height ?? this.start - 1n) !== block.number - 1n)
          return false;
      }

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
        mint: item.type === 126 ? (item.mint ?? 0n) : null,
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

      if (derived && prepared)
        await indexDerived(tx, block, prepared, this.start, derived);

      await tx
        .update(chainStatus)
        .set({ indexedBlock: block.number })
        .where(eq(chainStatus.id, 1));
      return true;
    });
    if (saved) await this.verify(block);
    return saved;
  }

  private async verify(block: { number: bigint; hash: Hex; parentHash: Hex }) {
    if (this.derived && block.number % 100n === 0n)
      await verifyBalances(this.db, block, this.derived.state);
  }

  async updateFinality(finality: Finality, expected: Position | undefined) {
    return this.db.transaction(async (tx) => {
      await tx.execute(chainLock);
      if (!same(await tip(tx), expected)) return false;
      const [status] = await tx
        .select()
        .from(chainStatus)
        .where(eq(chainStatus.id, 1));
      if (
        !status ||
        status.indexedBlock !== (expected?.number ?? this.start - 1n)
      )
        return false;
      for (const ref of [finality.safe, finality.finalized]) {
        if (ref === null) continue;
        if (!expected || ref.number > expected.number)
          throw new Error("Finality exceeds the indexed range");
        const [block] = await tx
          .select({ hash: blocks.hash })
          .from(blocks)
          .where(eq(blocks.number, ref.number));
        if (!block || bytesToHex(block.hash) !== ref.hash)
          throw new Error("L2 finality does not match the indexed block");
      }
      if (
        status.finalizedBlock !== null &&
        (finality.finalized === null ||
          finality.finalized.number < status.finalizedBlock)
      )
        throw new Error(
          "Observed finality moved below the indexed finalized block",
        );
      await tx
        .update(chainStatus)
        .set({
          unsafeBlock: finality.unsafe,
          safeBlock: finality.safe?.number ?? null,
          finalizedBlock: finality.finalized?.number ?? null,
        })
        .where(eq(chainStatus.id, 1));
      return true;
    });
  }
}
