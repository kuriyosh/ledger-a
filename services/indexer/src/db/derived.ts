import { logService } from "@ledgera/shared/server";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { type Address, bytesToHex, type Hex, zeroAddress } from "viem";
import { type DecodableTransaction, type decoder, isToken } from "../decode.ts";
import type { chainState } from "../state.ts";
import {
  balancesHistory,
  blocks,
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
import type { IndexerDatabase, IndexerTransaction } from "./store.ts";

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

export async function registryAtTip(
  tx: Pick<IndexerDatabase, "select">,
  height?: bigint,
) {
  const [checkpoint] = await tx
    .select({
      enforcementEnabled: registryCheckpoints.enforcementEnabled,
      registryVersion: registryCheckpoints.registryVersion,
    })
    .from(registryCheckpoints)
    .where(
      height === undefined
        ? undefined
        : lte(registryCheckpoints.blockNumber, height),
    )
    .orderBy(desc(registryCheckpoints.blockNumber))
    .limit(1);
  return checkpoint ?? zero;
}

export async function storedEntries(
  tx: Pick<IndexerDatabase, "select">,
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

const balanceKey = (token: Address, account: Address) =>
  `${token.toLowerCase()}:${account.toLowerCase()}`;

async function storedBalance(
  db: Pick<IndexerDatabase, "select">,
  token: Address,
  account: Address,
  before: bigint,
) {
  const [row] = await db
    .select({ balance: balancesHistory.balance })
    .from(balancesHistory)
    .where(
      and(
        eq(balancesHistory.token, bytes(token)),
        eq(balancesHistory.account, bytes(account)),
        lte(balancesHistory.blockNumber, before),
      ),
    )
    .orderBy(desc(balancesHistory.blockNumber), desc(balancesHistory.logIndex))
    .limit(1);
  return row?.balance;
}

export async function prepareDerived(
  db: IndexerDatabase,
  block: Block,
  raw: Entry[],
  start: bigint,
  derived: Derived,
) {
  const entries = raw.map(({ hash, transaction }) => ({
    hash,
    decoded: derived.decode(transaction),
  }));
  const initialBalances = new Map<string, bigint>();
  if (start === 0n) return { entries, initialBalances, registry: undefined };

  const touched = new Map<string, { token: Address; account: Address }>();
  for (const { decoded } of entries)
    for (const event of decoded.events) {
      if (!isToken(event.contract) || event.name !== "Transfer") continue;
      const token = derived.tokens[event.contract];
      for (const account of [event.args.from, event.args.to] as Address[])
        if (account !== zeroAddress)
          touched.set(balanceKey(token, account), { token, account });
    }
  const accounts = [...touched];
  for (let from = 0; from < accounts.length; from += 12) {
    await Promise.all(
      accounts.slice(from, from + 12).map(async ([key, { token, account }]) => {
        if (
          (await storedBalance(db, token, account, block.number - 1n)) ===
          undefined
        )
          initialBalances.set(
            key,
            await derived.state.balance(token, account, block.parentHash),
          );
      }),
    );
  }
  const registry =
    block.number === start
      ? await derived.state.registry(block.parentHash)
      : undefined;
  return { entries, initialBalances, registry };
}

export async function indexDerived(
  tx: IndexerTransaction,
  block: Block,
  prepared: Awaited<ReturnType<typeof prepareDerived>>,
  start: bigint,
  derived: Derived,
) {
  const registry = { ...(prepared.registry ?? (await registryAtTip(tx))) };
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
    const key = balanceKey(token, account);
    const prior =
      running.get(key) ??
      (await storedBalance(tx, token, account, block.number - 1n)) ??
      prepared.initialBalances.get(key) ??
      (start === 0n ? 0n : undefined);
    if (prior === undefined)
      throw new Error(
        "The branch changed while preparing initial token balances",
      );
    const balance = prior + delta;
    if (balance < 0n)
      throw new Error(
        `Negative indexed balance for ${token} and ${account} at block ${block.number}`,
      );
    running.set(key, balance);
    balanceRows.push({
      token: bytes(token),
      account: bytes(account),
      logIndex,
      blockNumber: block.number,
      balance,
    });
  }

  for (const { hash, decoded } of prepared.entries) {
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
        // These Registry events advance the version without including it in the log.
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
  db: IndexerDatabase,
  block: Block,
  state: Derived["state"],
) {
  const snapshot = await db.transaction(
    async (tx) => {
      const [indexed] = await tx
        .select({ hash: blocks.hash })
        .from(blocks)
        .where(eq(blocks.number, block.number));
      if (!indexed || bytesToHex(indexed.hash) !== block.hash) return;
      const accounts = await tx
        .selectDistinctOn([balancesHistory.token, balancesHistory.account], {
          token: balancesHistory.token,
          account: balancesHistory.account,
          balance: balancesHistory.balance,
        })
        .from(balancesHistory)
        .where(
          and(
            gt(balancesHistory.blockNumber, block.number - 100n),
            lte(balancesHistory.blockNumber, block.number),
          ),
        )
        .orderBy(
          asc(balancesHistory.token),
          asc(balancesHistory.account),
          desc(balancesHistory.blockNumber),
          desc(balancesHistory.logIndex),
        );
      return { accounts, registry: await registryAtTip(tx, block.number) };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  if (!snapshot) return;
  const { accounts, registry } = snapshot;
  try {
    const observed = await state.registry(block.hash);
    if (
      observed.enforcementEnabled !== registry.enforcementEnabled ||
      observed.registryVersion !== registry.registryVersion
    )
      logService(
        "indexer",
        "error",
        "Indexed Registry state differs from L2",
        null,
        {
          blockNumber: block.number.toString(),
          indexed: registry.registryVersion.toString(),
          observed: observed.registryVersion.toString(),
        },
      );
  } catch (error) {
    logService(
      "indexer",
      "error",
      "Could not verify indexed Registry state",
      null,
      {
        blockNumber: block.number.toString(),
        reason: error instanceof Error ? error.name : "Unknown error",
      },
    );
  }
  async function verify(row: (typeof accounts)[number]) {
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
  for (let from = 0; from < accounts.length; from += 12)
    await Promise.all(accounts.slice(from, from + 12).map(verify));
}
