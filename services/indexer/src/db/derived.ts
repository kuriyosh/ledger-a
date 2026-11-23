import { logService } from "@ledgera/shared/server";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { type Address, bytesToHex, type Hex, zeroAddress } from "viem";
import { type DecodableTransaction, type decoder, isToken } from "../decode.ts";
import type { chainState } from "../state.ts";
import {
  balancesHistory,
  chainStatus,
  logs,
  receiptCommitments,
  registryAccountEvents,
  registryCheckpoints,
  registryVaspEvents,
  safeEvents,
  swaps,
  tokenAdminEvents,
  tokenTransfers,
  transactions,
  travelRuleAttestations,
} from "./schema.ts";
import type { IndexerTransaction } from "./store.ts";

type Block = { number: bigint; hash: Hex; parentHash: Hex };
type Entry = {
  hash: Buffer;
  transaction: DecodableTransaction;
};
export type Derived = {
  decode: ReturnType<typeof decoder>;
  state: ReturnType<typeof chainState>;
  tokens: { tJPY: Address; tUSD: Address };
};

const zero = { enforcementEnabled: false, registryVersion: 0n };
const bytes = (value: unknown) => Buffer.from((value as Hex).slice(2), "hex");
const adminEvents = new Set([
  "AddressFrozen",
  "TokensFrozen",
  "TokensUnfrozen",
  "Paused",
  "Unpaused",
]);
const vaspEvents = new Set([
  "VaspRegistered",
  "VaspStatusChanged",
  "VaspKeysChanged",
  "VaspEndpointChanged",
]);
const safeKinds = new Set([
  "ApproveHash",
  "ExecutionSuccess",
  "ExecutionFailure",
]);

export async function registryAtTip(tx: IndexerTransaction) {
  const [checkpoint] = await tx
    .select({
      enforcementEnabled: registryCheckpoints.enforcementEnabled,
      registryVersion: registryCheckpoints.registryVersion,
    })
    .from(registryCheckpoints)
    .orderBy(desc(registryCheckpoints.blockNumber))
    .limit(1);
  return checkpoint ?? zero;
}

export async function storedEntries(
  tx: IndexerTransaction,
  number: bigint,
): Promise<Entry[]> {
  const entries = await tx
    .select()
    .from(transactions)
    .where(eq(transactions.blockNumber, number))
    .orderBy(asc(transactions.txIndex));
  const raw = await tx
    .select()
    .from(logs)
    .where(eq(logs.blockNumber, number))
    .orderBy(asc(logs.logIndex));
  const events = new Map<string, Array<DecodableTransaction["logs"][number]>>();
  for (const log of raw) {
    const hash = bytesToHex(log.txHash);
    const group = events.get(hash) ?? [];
    group.push({
      address: bytesToHex(log.address),
      topics: [log.topic0, log.topic1, log.topic2, log.topic3]
        .filter((topic) => topic !== null)
        .map((topic) => bytesToHex(topic)),
      data: bytesToHex(log.data),
      logIndex: log.logIndex,
    });
    events.set(hash, group);
  }
  return entries.map((entry) => ({
    hash: entry.hash,
    transaction: {
      from: bytesToHex(entry.fromAddress),
      to: entry.toAddress && bytesToHex(entry.toAddress),
      type: entry.type,
      input: bytesToHex(entry.input),
      logs: events.get(bytesToHex(entry.hash)) ?? [],
    },
  }));
}

export async function indexDerived(
  tx: IndexerTransaction,
  block: Block,
  entries: Entry[],
  start: bigint,
  derived: Derived,
) {
  const registry =
    block.number === start && start > 0n
      ? await derived.state.registry(block.parentHash)
      : { ...(await registryAtTip(tx)) };
  let registryChanged = block.number === start;
  const running = new Map<string, bigint>();
  const balanceRows: (typeof balancesHistory.$inferInsert)[] = [];

  async function move(
    token: Address,
    account: Address,
    delta: bigint,
    logIndex: number,
  ) {
    if (account === zeroAddress) return;
    const key = `${token.toLowerCase()}:${account.toLowerCase()}`;
    let prior = running.get(key);
    if (prior === undefined) {
      const [last] = await tx
        .select({ balance: balancesHistory.balance })
        .from(balancesHistory)
        .where(
          and(
            eq(balancesHistory.token, bytes(token)),
            eq(balancesHistory.account, bytes(account)),
          ),
        )
        .orderBy(
          desc(balancesHistory.blockNumber),
          desc(balancesHistory.logIndex),
        )
        .limit(1);
      prior =
        last?.balance ??
        (start === 0n
          ? 0n
          : await derived.state.balance(token, account, block.parentHash));
    }
    const balance = prior + delta;
    if (balance < 0n)
      throw new Error("Transfer would make the indexed balance negative");
    running.set(key, balance);
    balanceRows.push({
      token: bytes(token),
      account: bytes(account),
      logIndex,
      blockNumber: block.number,
      balance,
    });
  }

  for (const { hash, transaction } of entries) {
    const decoded = derived.decode(transaction);
    await tx
      .update(transactions)
      .set({ decodedCall: decoded.call ?? null, kind: decoded.kind })
      .where(eq(transactions.hash, hash));
    const transfers: (typeof tokenTransfers.$inferInsert)[] = [];
    for (const event of decoded.events) {
      const position = {
        blockNumber: block.number,
        logIndex: event.logIndex,
        txHash: hash,
      };
      const { args, contract, name } = event;
      const record = { ...position, event: name, args };
      if (isToken(contract)) {
        const address = derived.tokens[contract];
        const token = bytes(address);
        if (name === "Transfer") {
          const from = args.from as Address;
          const to = args.to as Address;
          const amount = BigInt(args.value as string);
          transfers.push({
            ...position,
            token,
            fromAddress: bytes(from),
            toAddress: bytes(to),
            amount,
          });
          if (from === to) {
            await move(address, from, 0n, event.logIndex);
          } else {
            await move(address, from, -amount, event.logIndex);
            await move(address, to, amount, event.logIndex);
          }
        } else if (name === "TravelRuleTransfer") {
          const transfer = transfers.at(-1);
          if (
            transfer &&
            transfer.logIndex + 1 === event.logIndex &&
            transfer.token.equals(token) &&
            transfer.fromAddress.equals(bytes(args.from)) &&
            transfer.toAddress.equals(bytes(args.to)) &&
            transfer.amount === BigInt(args.amount as string)
          )
            transfer.travelRuleRef = bytes(args.refId);
        } else if (adminEvents.has(name)) {
          await tx.insert(tokenAdminEvents).values({ ...record, token });
        }
      } else if (contract === "kycRegistry") {
        if (
          name === "ConsortiumTransferred" ||
          name === "VaspEndpointChanged"
        ) {
          registry.registryVersion += 1n;
          registryChanged = true;
        } else if (args.version !== undefined) {
          registry.registryVersion = BigInt(args.version as string);
          registryChanged = true;
        }
        if (name === "EnforcementEnabled") registry.enforcementEnabled = true;
        if (name === "AccountUpdated")
          await tx.insert(registryAccountEvents).values({
            ...position,
            account: bytes(args.account),
            vaspId: BigInt(args.vaspId as number),
            kind: args.kind as number,
            status: args.status as number,
            validUntil: BigInt(args.validUntil as string),
            version: BigInt(args.version as string),
            actor: bytes(args.actor),
            reason: bytes(args.reason),
          });
        if (vaspEvents.has(name))
          await tx
            .insert(registryVaspEvents)
            .values({ ...record, vaspId: BigInt(args.vaspId as number) });
      } else if (
        contract === "travelRuleCompliance" &&
        name === "TravelRuleAttestationConsumed"
      ) {
        await tx
          .insert(travelRuleAttestations)
          .values({ ...record, refId: bytes(args.refId) });
      } else if (contract === "atomicSwap" && name === "Filled") {
        await tx.insert(swaps).values({
          ...record,
          maker: bytes(args.maker),
          taker: bytes(args.taker),
        });
      } else if (contract === "consortiumSafe" && safeKinds.has(name)) {
        await tx.insert(safeEvents).values({
          ...record,
          safeTxHash: bytes(args.approvedHash ?? args.txHash),
        });
      } else if (contract === "receiptLog" && name === "Committed") {
        await tx.insert(receiptCommitments).values(record);
      }
    }
    for (let from = 0; from < transfers.length; from += 500)
      await tx.insert(tokenTransfers).values(transfers.slice(from, from + 500));
  }
  for (let from = 0; from < balanceRows.length; from += 500)
    await tx
      .insert(balancesHistory)
      .values(balanceRows.slice(from, from + 500));
  if (registryChanged)
    await tx
      .insert(registryCheckpoints)
      .values({ blockNumber: block.number, ...registry });
  await tx
    .update(chainStatus)
    .set({ derivedBlock: block.number, ...registry })
    .where(eq(chainStatus.id, 1));
}

export async function verifyBalances(
  tx: IndexerTransaction,
  block: Block,
  state: Derived["state"],
) {
  const accounts = await tx
    .selectDistinctOn([balancesHistory.token, balancesHistory.account], {
      token: balancesHistory.token,
      account: balancesHistory.account,
      balance: balancesHistory.balance,
    })
    .from(balancesHistory)
    .where(gt(balancesHistory.blockNumber, block.number - 100n))
    .orderBy(
      asc(balancesHistory.token),
      asc(balancesHistory.account),
      desc(balancesHistory.blockNumber),
      desc(balancesHistory.logIndex),
    );
  for (const row of accounts) {
    const token = bytesToHex(row.token);
    const account = bytesToHex(row.account);
    try {
      const balance = await state.balance(token, account, block.hash);
      if (balance !== row.balance)
        logService(
          "indexer",
          "error",
          "Indexed token balance differs from L2",
          null,
          {
            token,
            account,
            blockNumber: block.number.toString(),
            indexed: row.balance.toString(),
            observed: balance.toString(),
          },
        );
    } catch (error) {
      logService(
        "indexer",
        "error",
        "Could not verify indexed token balance",
        null,
        {
          token,
          account,
          blockNumber: block.number.toString(),
          reason: error instanceof Error ? error.name : "Unknown error",
        },
      );
    }
  }
}
