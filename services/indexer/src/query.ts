import { ServiceError } from "@ledgera/shared/errors";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type Address, bytesToHex, type Hex } from "viem";
import {
  blocks,
  chainStatus,
  logs,
  receiptCommitments,
  type registryAccountEvents,
  safeEvents,
  swaps,
  tokenTransfers,
  transactions,
  travelRuleAttestations,
} from "./db/schema.ts";
import type { IndexerDatabase } from "./db/store.ts";
import type { decoder } from "./decode.ts";

export const bytes = (value: Hex) => Buffer.from(value.slice(2), "hex");

export type Cursor = { block: bigint; index?: number };
export type Page = { limit: number; before?: Cursor };
export type ChainStatus = typeof chainStatus.$inferSelect;
type Reader = Pick<IndexerDatabase, "select">;
type Position = { blockNumber: bigint; logIndex: number; txHash: Buffer };

function safety(block: bigint, status: ChainStatus) {
  if (status.finalizedBlock !== null && block <= status.finalizedBlock)
    return "finalized";
  if (status.safeBlock !== null && block <= status.safeBlock) return "safe";
  return "unsafe";
}

export async function readStatus(db: Reader) {
  const [status] = await db
    .select()
    .from(chainStatus)
    .where(eq(chainStatus.id, 1));
  if (!status)
    throw new ServiceError(
      "INDEXER_UNAVAILABLE",
      "Indexer status unavailable",
      503,
    );
  return status;
}

export function beforePosition(
  cursor: Cursor | undefined,
  field:
    | typeof transactions.blockNumber
    | typeof tokenTransfers.blockNumber
    | typeof registryAccountEvents.blockNumber,
  index:
    | typeof transactions.txIndex
    | typeof tokenTransfers.logIndex
    | typeof registryAccountEvents.logIndex,
) {
  if (!cursor) return undefined;
  return cursor.index === undefined
    ? lt(field, cursor.block)
    : or(
        lt(field, cursor.block),
        and(eq(field, cursor.block), lt(index, cursor.index)),
      );
}

function pageResult<Row, View>(
  input: Row[],
  limit: number,
  view: (row: Row) => View,
  cursor: (row: Row) => string,
) {
  const visible = input.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(view),
    nextBefore: input.length > limit && last ? cursor(last) : null,
  };
}

function blockView(row: typeof blocks.$inferSelect, status: ChainStatus) {
  return {
    number: row.number.toString(),
    hash: bytesToHex(row.hash),
    parentHash: bytesToHex(row.parentHash),
    timestamp: row.timestamp,
    txCount: row.txCount,
    safety: safety(row.number, status),
  };
}

function txView(
  row: typeof transactions.$inferSelect,
  timestamp: Date,
  status: ChainStatus,
) {
  const types: Record<number, string> = {
    0: "legacy",
    1: "eip2930",
    2: "eip1559",
    3: "eip4844",
    4: "eip7702",
    125: "post-exec",
    126: "deposit",
  };
  return {
    hash: bytesToHex(row.hash),
    blockNumber: row.blockNumber.toString(),
    txIndex: row.txIndex,
    timestamp,
    safety: safety(row.blockNumber, status),
    type: types[row.type] ?? "unknown",
    typeId: row.type,
    from: bytesToHex(row.fromAddress),
    to: row.toAddress && bytesToHex(row.toAddress),
    value: row.value.toString(),
    nonce: row.nonce.toString(),
    gasLimit: row.gasLimit.toString(),
    gasUsed: row.gasUsed.toString(),
    status: row.status === 1 ? "success" : "failed",
    kind: row.kind,
    call: row.decodedCall,
    failure: row.failureKind && {
      kind: row.failureKind,
      ...(row.failureDetail as Record<string, unknown>),
    },
    mint: row.mint?.toString() ?? null,
  };
}

export function position(row: Position) {
  return {
    blockNumber: row.blockNumber.toString(),
    logIndex: row.logIndex,
    txHash: bytesToHex(row.txHash),
  };
}

function transferView(row: typeof tokenTransfers.$inferSelect) {
  return {
    ...position(row),
    token: bytesToHex(row.token),
    from: bytesToHex(row.fromAddress),
    to: bytesToHex(row.toAddress),
    amount: row.amount.toString(),
    travelRuleRef: row.travelRuleRef && bytesToHex(row.travelRuleRef),
  };
}

function knownEvent(
  row: Position & { event: string; args: Record<string, unknown> },
) {
  return { ...position(row), event: row.event, args: row.args };
}

export function chainQuery(
  db: IndexerDatabase,
  decode: ReturnType<typeof decoder>,
) {
  function snapshot<T>(
    act: (reader: Reader, state: ChainStatus) => Promise<T>,
  ) {
    return db.transaction(async (tx) => act(tx, await readStatus(tx)), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }

  return {
    status: () =>
      snapshot(async (_, state) => ({
        startBlock: state.startBlock.toString(),
        indexedBlock: state.indexedBlock.toString(),
        derivedBlock: state.derivedBlock?.toString() ?? null,
        unsafeBlock: state.unsafeBlock?.toString() ?? null,
        safeBlock: state.safeBlock?.toString() ?? null,
        finalizedBlock: state.finalizedBlock?.toString() ?? null,
        enforcementEnabled: state.enforcementEnabled,
        registryVersion: state.registryVersion.toString(),
      })),
    blocks(input: { limit: number; before?: bigint }) {
      return snapshot(async (reader, state) => {
        const rows = await reader
          .select()
          .from(blocks)
          .where(
            input.before === undefined
              ? undefined
              : lt(blocks.number, input.before),
          )
          .orderBy(desc(blocks.number))
          .limit(input.limit + 1);
        const page = pageResult(
          rows,
          input.limit,
          (row) => blockView(row, state),
          (row) => row.number.toString(),
        );
        return { blocks: page.items, nextBefore: page.nextBefore };
      });
    },
    transactions(input: Page & { address?: Address; kind?: string }) {
      return snapshot(async (reader, state) => {
        let address: SQL | undefined;
        if (input.address) {
          const value = bytes(input.address);
          address = or(
            eq(transactions.fromAddress, value),
            eq(transactions.toAddress, value),
            exists(
              reader
                .select({ one: sql`1` })
                .from(tokenTransfers)
                .where(
                  and(
                    eq(tokenTransfers.txHash, transactions.hash),
                    or(
                      eq(tokenTransfers.fromAddress, value),
                      eq(tokenTransfers.toAddress, value),
                    ),
                  ),
                ),
            ),
          );
        }
        const rows = await reader
          .select({ transaction: transactions, timestamp: blocks.timestamp })
          .from(transactions)
          .innerJoin(blocks, eq(transactions.blockNumber, blocks.number))
          .where(
            and(
              address,
              lte(
                transactions.blockNumber,
                state.derivedBlock ?? state.startBlock - 1n,
              ),
              input.kind ? eq(transactions.kind, input.kind) : undefined,
              beforePosition(
                input.before,
                transactions.blockNumber,
                transactions.txIndex,
              ),
            ),
          )
          .orderBy(desc(transactions.blockNumber), desc(transactions.txIndex))
          .limit(input.limit + 1);
        const page = pageResult(
          rows,
          input.limit,
          (row) => txView(row.transaction, row.timestamp, state),
          ({ transaction: row }) => `${row.blockNumber}:${row.txIndex}`,
        );
        return {
          transactions: page.items,
          nextBefore: page.nextBefore,
          blockNumber: state.derivedBlock?.toString() ?? null,
        };
      });
    },
    transaction(hash: Hex) {
      return snapshot(async (reader, state) => {
        const [found] = await reader
          .select({ transaction: transactions, timestamp: blocks.timestamp })
          .from(transactions)
          .innerJoin(blocks, eq(transactions.blockNumber, blocks.number))
          .where(eq(transactions.hash, bytes(hash)));
        if (!found)
          throw new ServiceError(
            "TRANSACTION_NOT_FOUND",
            "Indexed transaction not found",
            404,
          );
        const row = found.transaction;
        const rawLogs = (
          await reader
            .select()
            .from(logs)
            .where(eq(logs.txHash, row.hash))
            .orderBy(asc(logs.logIndex))
        ).map((log) => ({
          address: bytesToHex(log.address),
          logIndex: log.logIndex,
          data: bytesToHex(log.data),
          topics: [log.topic0, log.topic1, log.topic2, log.topic3]
            .filter((topic) => topic !== null)
            .map((topic) => bytesToHex(topic)),
        }));
        const decoded = decode({
          type: row.type,
          from: bytesToHex(row.fromAddress),
          to: row.toAddress && bytesToHex(row.toAddress),
          input: bytesToHex(row.input),
          logs: rawLogs,
        });
        const byIndex = new Map(
          decoded.events.map((event) => [event.logIndex, event]),
        );
        return {
          ...txView(row, found.timestamp, state),
          input: bytesToHex(row.input),
          events: rawLogs.map((log) => ({
            ...log,
            ...byIndex.get(log.logIndex),
          })),
        };
      });
    },
    async transfers(account: Address, input: Page & { token?: Address }) {
      const address = bytes(account);
      const rows = await db
        .select()
        .from(tokenTransfers)
        .where(
          and(
            or(
              eq(tokenTransfers.fromAddress, address),
              eq(tokenTransfers.toAddress, address),
            ),
            input.token
              ? eq(tokenTransfers.token, bytes(input.token))
              : undefined,
            beforePosition(
              input.before,
              tokenTransfers.blockNumber,
              tokenTransfers.logIndex,
            ),
          ),
        )
        .orderBy(
          desc(tokenTransfers.blockNumber),
          desc(tokenTransfers.logIndex),
        )
        .limit(input.limit + 1);
      const page = pageResult(
        rows,
        input.limit,
        transferView,
        (row) => `${row.blockNumber}:${row.logIndex}`,
      );
      return { transfers: page.items, nextBefore: page.nextBefore };
    },
    travelRule(refId: Hex) {
      return snapshot(async (reader) => {
        const ref = bytes(refId);
        const attestations = await reader
          .select()
          .from(travelRuleAttestations)
          .where(eq(travelRuleAttestations.refId, ref))
          .orderBy(
            asc(travelRuleAttestations.blockNumber),
            asc(travelRuleAttestations.logIndex),
          );
        const transfers = await reader
          .select()
          .from(tokenTransfers)
          .where(eq(tokenTransfers.travelRuleRef, ref))
          .orderBy(
            asc(tokenTransfers.blockNumber),
            asc(tokenTransfers.logIndex),
          );
        if (!attestations.length && !transfers.length)
          throw new ServiceError(
            "TRAVEL_RULE_NOT_FOUND",
            "Travel Rule reference not found",
            404,
          );
        return {
          refId,
          attestations: attestations.map(knownEvent),
          transfers: transfers.map(transferView),
        };
      });
    },
    async swaps(account: Address | undefined, limit: number) {
      const address = account && bytes(account);
      const rows = await db
        .select()
        .from(swaps)
        .where(
          address
            ? or(eq(swaps.maker, address), eq(swaps.taker, address))
            : undefined,
        )
        .orderBy(desc(swaps.blockNumber), desc(swaps.logIndex))
        .limit(limit);
      return { swaps: rows.map(knownEvent) };
    },
    async safe(hash: Hex) {
      const rows = await db
        .select()
        .from(safeEvents)
        .where(eq(safeEvents.safeTxHash, bytes(hash)))
        .orderBy(asc(safeEvents.blockNumber), asc(safeEvents.logIndex));
      if (!rows.length)
        throw new ServiceError(
          "SAFE_TX_NOT_FOUND",
          "Safe transaction not found",
          404,
        );
      return { safeTxHash: hash, events: rows.map(knownEvent) };
    },
    async receiptCommitments(limit: number) {
      const rows = await db
        .select()
        .from(receiptCommitments)
        .orderBy(
          desc(receiptCommitments.blockNumber),
          desc(receiptCommitments.logIndex),
        )
        .limit(limit);
      return { commitments: rows.map(knownEvent) };
    },
  };
}
