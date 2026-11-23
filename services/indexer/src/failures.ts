import { setTimeout } from "node:timers/promises";
import { kycRegistryAbi } from "@ledgera/abis";
import type { Deployment } from "@ledgera/config";
import { logService } from "@ledgera/shared/server";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  getAbiItem,
  type Hex,
  http,
  toEventSelector,
  zeroAddress,
} from "viem";
import {
  blocks,
  chainStatus,
  logs,
  registryAccountEvents,
  registryCheckpoints,
  registryVaspEvents,
  transactions,
} from "./db/schema.ts";
import type { IndexerDatabase, IndexerTransaction } from "./db/store.ts";
import { errorDecoder } from "./decode.ts";
import type { indexerRpc, TraceFrame } from "./rpc.ts";

const batchSize = 24;
const l1AttributesSender = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001";
const enabledTopic = toEventSelector(
  getAbiItem({ abi: kycRegistryAbi, name: "EnforcementEnabled" }),
);
const bytes = (value: Hex) => Buffer.from(value.slice(2), "hex");

export function deepestFailure(trace: TraceFrame) {
  let failure: TraceFrame | undefined;
  let maxDepth = -1;
  const remaining = [{ frame: trace, depth: 0 }];
  while (remaining.length) {
    const next = remaining.pop();
    if (!next) break;
    const { frame, depth } = next;
    if (frame.error && depth > maxDepth) {
      maxDepth = depth;
      failure = frame;
    }
    for (const inner of [...(frame.calls ?? [])].reverse())
      remaining.push({ frame: inner, depth: depth + 1 });
  }
  return failure;
}

type Location = {
  number: bigint;
  hash: Buffer;
  parent: Buffer;
  timestamp: Date;
  txIndex: number;
  from: Buffer;
  start: bigint;
};
type Account = {
  vaspId: number;
  kind: number;
  status: number;
  validUntil: bigint;
};

function knownBefore(
  height:
    | typeof registryAccountEvents.blockNumber
    | typeof registryVaspEvents.blockNumber
    | typeof logs.blockNumber,
  position: Location,
) {
  return or(
    lt(height, position.number),
    and(
      eq(height, position.number),
      lt(transactions.txIndex, position.txIndex),
    ),
  );
}

export function evaluateDeposit(
  account: Account,
  vaspStatus: number,
  timestamp: bigint,
) {
  if (
    account.status !== 1 ||
    vaspStatus !== 1 ||
    (account.validUntil !== 0n && timestamp > account.validUntil)
  )
    return {
      accountStatus: account.status,
      kind: account.kind,
      vaspId: account.vaspId,
      vaspStatus,
      validUntil: account.validUntil.toString(),
    };
}

export function failureWorker(
  database: IndexerDatabase,
  deployment: Deployment,
  url: string,
  rpc: Pick<ReturnType<typeof indexerRpc>, "header" | "trace">,
) {
  const decode = errorDecoder(deployment.contracts);
  const client = createPublicClient({
    transport: http(url, { timeout: 5_000, retryCount: 0 }),
  });
  const registry = deployment.contracts.kycRegistry;

  async function enabledBefore(tx: IndexerTransaction, position: Location) {
    const [prior] = await tx
      .select({ enabled: registryCheckpoints.enforcementEnabled })
      .from(registryCheckpoints)
      .where(lt(registryCheckpoints.blockNumber, position.number))
      .orderBy(desc(registryCheckpoints.blockNumber))
      .limit(1);
    if (prior?.enabled) return true;
    const [enabled] = await tx
      .select({ logIndex: logs.logIndex })
      .from(logs)
      .innerJoin(transactions, eq(logs.txHash, transactions.hash))
      .where(
        and(
          eq(logs.address, bytes(registry)),
          eq(logs.topic0, bytes(enabledTopic)),
          eq(logs.blockNumber, position.number),
          lt(transactions.txIndex, position.txIndex),
        ),
      )
      .limit(1);
    if (enabled) return true;
    if (!prior && position.number === position.start && position.start > 0n)
      return undefined;
    return false;
  }

  async function depositLocation(position: Location) {
    return database.transaction(
      async (tx) => {
        const [block] = await tx
          .select({ hash: blocks.hash })
          .from(blocks)
          .where(eq(blocks.number, position.number));
        if (!block?.hash.equals(position.hash)) return;
        const enforce = await enabledBefore(tx, position);
        if (enforce === false) return { enforce };
        const [account] = await tx
          .select({
            vaspId: registryAccountEvents.vaspId,
            kind: registryAccountEvents.kind,
            status: registryAccountEvents.status,
            validUntil: registryAccountEvents.validUntil,
          })
          .from(registryAccountEvents)
          .innerJoin(
            transactions,
            eq(registryAccountEvents.txHash, transactions.hash),
          )
          .where(
            and(
              eq(registryAccountEvents.account, position.from),
              knownBefore(registryAccountEvents.blockNumber, position),
            ),
          )
          .orderBy(
            desc(registryAccountEvents.blockNumber),
            desc(registryAccountEvents.logIndex),
          )
          .limit(1);
        return {
          enforce,
          account: account
            ? { ...account, vaspId: Number(account.vaspId) }
            : undefined,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async function detectIneligible(position: Location) {
    const sender: Address = bytesToHex(position.from);
    if (sender === zeroAddress || sender === l1AttributesSender) return;
    const state = await depositLocation(position);
    if (!state || state.enforce === false) return;
    const options = {
      address: registry,
      abi: kycRegistryAbi,
      blockHash: bytesToHex(position.parent),
      requireCanonical: true,
    } as const;
    const enforce =
      state.enforce ??
      (await client.readContract({
        ...options,
        functionName: "enforcementEnabled",
      }));
    if (!enforce) return;
    const empty = { vaspId: 0, kind: 0, status: 0, validUntil: 0n };
    const account =
      state.account ??
      (position.start === 0n
        ? empty
        : await client.readContract({
            ...options,
            functionName: "getAccount",
            args: [sender],
          }));
    const [last] = await database
      .select({
        event: registryVaspEvents.event,
        args: registryVaspEvents.args,
      })
      .from(registryVaspEvents)
      .innerJoin(transactions, eq(registryVaspEvents.txHash, transactions.hash))
      .where(
        and(
          eq(registryVaspEvents.vaspId, BigInt(account.vaspId)),
          inArray(registryVaspEvents.event, [
            "VaspRegistered",
            "VaspStatusChanged",
          ]),
          knownBefore(registryVaspEvents.blockNumber, position),
        ),
      )
      .orderBy(
        desc(registryVaspEvents.blockNumber),
        desc(registryVaspEvents.logIndex),
      )
      .limit(1);
    const vaspStatus = last
      ? last.event === "VaspRegistered"
        ? 1
        : Number(last.args.status)
      : position.start === 0n
        ? 0
        : (
            await client.readContract({
              ...options,
              functionName: "getVasp",
              args: [account.vaspId],
            })
          ).status;
    const detail = evaluateDeposit(
      account,
      vaspStatus,
      BigInt(position.timestamp.getTime() / 1_000),
    );
    return detail && { sender, ...detail };
  }

  async function batch(signal: AbortSignal) {
    const queue = await database
      .select({
        number: blocks.number,
        hash: blocks.hash,
        parent: blocks.parentHash,
        timestamp: blocks.timestamp,
        txHash: transactions.hash,
        txIndex: transactions.txIndex,
        from: transactions.fromAddress,
        kind: transactions.kind,
        start: chainStatus.startBlock,
      })
      .from(transactions)
      .innerJoin(blocks, eq(blocks.number, transactions.blockNumber))
      .innerJoin(
        chainStatus,
        and(
          eq(chainStatus.id, 1),
          lte(blocks.number, chainStatus.derivedBlock),
        ),
      )
      .where(and(eq(transactions.status, 0), isNull(transactions.failureKind)))
      .orderBy(asc(blocks.number), asc(transactions.txIndex))
      .limit(batchSize);

    for (const position of queue) {
      signal.throwIfAborted();
      const hash = bytesToHex(position.txHash);
      try {
        if (
          (await rpc.header(position.number)).hash !== bytesToHex(position.hash)
        )
          continue;
        const denied =
          position.kind === "DEPOSIT"
            ? await detectIneligible(position)
            : undefined;
        const trace = denied ? null : await rpc.trace(hash);
        const deepest = trace ? deepestFailure(trace) : undefined;
        const output = deepest?.output ?? trace?.output ?? "0x";
        const error = trace && decode(deepest?.to ?? trace.to, output);
        const reason = denied
          ? { failureKind: "SENDER_NOT_ALLOWED", failureDetail: denied }
          : error
            ? { failureKind: "REVERT", failureDetail: error }
            : {
                failureKind: "UNKNOWN",
                failureDetail: {
                  output,
                  ...(deepest?.error && { error: deepest.error }),
                },
              };
        if (
          (await rpc.header(position.number)).hash !== bytesToHex(position.hash)
        )
          continue;
        await database
          .update(transactions)
          .set(reason)
          .where(
            and(
              eq(transactions.hash, position.txHash),
              eq(transactions.blockNumber, position.number),
              isNull(transactions.failureKind),
              exists(
                database
                  .select({ one: sql`1` })
                  .from(blocks)
                  .where(
                    and(
                      eq(blocks.number, position.number),
                      eq(blocks.hash, position.hash),
                    ),
                  ),
              ),
            ),
          );
      } catch (error) {
        logService(
          "indexer",
          "error",
          "Could not index transaction failure",
          null,
          {
            hash,
            reason: error instanceof Error ? error.name : "Unknown error",
          },
        );
      }
    }
  }

  return {
    async run(signal: AbortSignal) {
      while (!signal.aborted) {
        try {
          await batch(signal);
        } catch (error) {
          if (!signal.aborted)
            logService(
              "indexer",
              "error",
              "Could not load failure queue",
              null,
              {
                reason: error instanceof Error ? error.name : "Unknown error",
              },
            );
        }
        await setTimeout(1_000, undefined, { signal }).catch(() => {});
      }
    },
  };
}
