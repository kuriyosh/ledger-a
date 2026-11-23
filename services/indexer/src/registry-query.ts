import { kycRegistryAbi } from "@ledgera/abis";
import type { Deployment } from "@ledgera/config";
import { ServiceError } from "@ledgera/shared/errors";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { type Address, bytesToHex, createPublicClient, http } from "viem";
import {
  balancesHistory,
  blocks,
  registryAccountEvents,
  registryVaspEvents,
} from "./db/schema.ts";
import type { IndexerDatabase, IndexerTransaction } from "./db/store.ts";
import {
  beforePosition,
  bytes,
  type Cursor,
  position,
  readStatus,
} from "./query.ts";
import type { chainState } from "./state.ts";

type Account = typeof registryAccountEvents.$inferSelect;
type Filters = {
  vaspId?: number;
  status?: number;
  registeredFromBlock?: bigint;
  limit: number;
  after?: Address;
};
const empty = {
  vaspId: 0,
  kind: 0,
  status: 0,
  validUntil: "0",
  updatedAt: null,
};

function accountView(row: Account) {
  return {
    ...position(row),
    address: bytesToHex(row.account),
    vaspId: Number(row.vaspId),
    kind: row.kind,
    status: row.status,
    validUntil: row.validUntil.toString(),
    version: row.version.toString(),
    actor: bytesToHex(row.actor),
    reason: bytesToHex(row.reason),
  };
}

export function registryQuery(
  db: IndexerDatabase,
  deployment: Deployment,
  rpc: string,
  state: ReturnType<typeof chainState>,
) {
  const contracts = deployment.contracts;
  const client = createPublicClient({
    transport: http(rpc, { retryCount: 0, timeout: 5_000 }),
  });
  function snapshot<T>(act: (tx: IndexerTransaction) => Promise<T>) {
    return db.transaction(act, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }

  async function anchor(tx: IndexerTransaction, height?: bigint) {
    const status = await readStatus(tx);
    const at = height ?? status.derivedBlock;
    if (at === null || status.derivedBlock === null)
      throw new ServiceError(
        "INDEXER_NOT_READY",
        "No indexed blocks available",
        503,
      );
    if (at > status.derivedBlock || at < status.startBlock)
      throw new ServiceError(
        "BLOCK_NOT_INDEXED",
        "Block is outside the indexed range",
        404,
      );
    const [row] = await tx
      .select({ hash: blocks.hash })
      .from(blocks)
      .where(eq(blocks.number, at));
    if (!row)
      throw new ServiceError("BLOCK_NOT_INDEXED", "Block not indexed", 404);
    return { at, hash: bytesToHex(row.hash), partial: status.startBlock > 0n };
  }

  async function historical<T>(request: () => Promise<T>) {
    try {
      return await request();
    } catch {
      throw new ServiceError(
        "L2_STATE_UNAVAILABLE",
        "Historical L2 state unavailable",
        503,
      );
    }
  }

  async function contractOptions(block: Awaited<ReturnType<typeof anchor>>) {
    const options = {
      address: contracts.kycRegistry,
      blockHash: block.hash,
      requireCanonical: true,
    } as const;
    const code = await historical(() => client.getCode(options));
    return code && code !== "0x"
      ? { ...options, abi: kycRegistryAbi }
      : undefined;
  }

  async function accountAt(
    address: Address,
    block: Awaited<ReturnType<typeof anchor>>,
    known?: Account,
  ) {
    if (known) return accountView(known);
    if (block.partial) {
      const options = await contractOptions(block);
      if (options) {
        const row = await historical(() =>
          client.readContract({
            ...options,
            functionName: "getAccount",
            args: [address],
          }),
        );
        return {
          ...row,
          address,
          validUntil: row.validUntil.toString(),
          updatedAt: row.updatedAt.toString(),
        };
      }
    }
    return { ...empty, address };
  }

  return {
    accounts(filters: Filters) {
      return snapshot(async (tx) => {
        const block = await anchor(tx);
        const range = filters.registeredFromBlock;
        const { rows } = await tx.execute<
          Account & { registeredBlock: string | null }
        >(sql`
          with history as (
            select e.*, t.decoded_call, lag(e.status) over (
              partition by e.account order by e.block_number, e.log_index
            ) as previous_status
            from indexer.registry_account_events e
            join indexer.transactions t on e.tx_hash = t.hash
            where e.block_number <= ${block.at.toString()}
          ), registrations as (
            select account, max(block_number) as registered_block
            from history
            where status = 1 and (
              previous_status in (0, 4) or (
                previous_status is null and (
                  not ${block.partial} or decoded_call->>'function' in ('registerAccount', 'registerOperatorAccount')
                )
              )
            )
            group by account
          ), latest as (
            select distinct on (account) * from history
            order by account, block_number desc, log_index desc
          )
          select entry.account, entry.vasp_id as "vaspId", entry.kind, entry.status,
            entry.valid_until as "validUntil", entry.version, entry.actor, entry.reason,
            entry.block_number as "blockNumber", entry.log_index as "logIndex", entry.tx_hash as "txHash",
            registrations.registered_block as "registeredBlock"
          from latest as entry
          left join registrations using (account)
          where true
            ${filters.vaspId === undefined ? sql`` : sql`and entry.vasp_id = ${filters.vaspId}`}
            ${filters.status === undefined ? sql`` : sql`and entry.status = ${filters.status}`}
            ${range === undefined ? sql`` : sql`and registrations.registered_block >= ${range.toString()}`}
            ${filters.after === undefined ? sql`` : sql`and entry.account > ${bytes(filters.after)}`}
          order by entry.account
          limit ${filters.limit + 1}
        `);
        const visible = rows.slice(0, filters.limit);
        const last = visible.at(-1);
        return {
          accounts: visible.map((row) => ({
            ...accountView(row),
            registeredFromBlock: row.registeredBlock,
          })),
          blockNumber: block.at.toString(),
          partial: block.partial,
          nextAfter:
            rows.length > filters.limit && last
              ? bytesToHex(last.account)
              : null,
        };
      });
    },
    async account(
      address: Address,
      at?: bigint,
      history?: { limit: number; before?: Cursor },
    ) {
      const data = await snapshot(async (tx) => {
        const block = await anchor(tx, at);
        const positions = and(
          eq(registryAccountEvents.account, bytes(address)),
          lte(registryAccountEvents.blockNumber, block.at),
        );
        const ordering = [
          desc(registryAccountEvents.blockNumber),
          desc(registryAccountEvents.logIndex),
        ];
        const [known] = await tx
          .select()
          .from(registryAccountEvents)
          .where(positions)
          .orderBy(...ordering)
          .limit(1);
        const rows = history
          ? await tx
              .select()
              .from(registryAccountEvents)
              .where(
                and(
                  positions,
                  beforePosition(
                    history.before,
                    registryAccountEvents.blockNumber,
                    registryAccountEvents.logIndex,
                  ),
                ),
              )
              .orderBy(...ordering)
              .limit(history.limit + 1)
          : [];
        return { block, known, rows };
      });
      const current = await accountAt(address, data.block, data.known);
      const visible = history ? data.rows.slice(0, history.limit) : [];
      const last = visible.at(-1);
      return {
        address,
        blockNumber: data.block.at.toString(),
        account: current,
        ...(history && {
          history: visible.map(accountView),
          nextBefore:
            data.rows.length > history.limit && last
              ? `${last.blockNumber}:${last.logIndex}`
              : null,
        }),
      };
    },
    async vasps() {
      const { block, events } = await snapshot(async (tx) => ({
        block: await anchor(tx),
        events: await tx
          .select()
          .from(registryVaspEvents)
          .orderBy(
            asc(registryVaspEvents.blockNumber),
            asc(registryVaspEvents.logIndex),
          ),
      }));
      if (block.partial) {
        const ids = [
          ...new Set([
            ...Object.values(deployment.vasps),
            ...events.map((event) => Number(event.vaspId)),
          ]),
        ].sort((a, b) => a - b);
        const options = await contractOptions(block);
        if (!options) return { vasps: [] };
        const entries = await Promise.all(
          ids.map(async (vaspId) => {
            const entry = await client.readContract({
              ...options,
              functionName: "getVasp",
              args: [vaspId],
            });
            return { ...entry, vaspId, updatedAt: entry.updatedAt.toString() };
          }),
        );
        return { vasps: entries.filter((entry) => entry.status !== 0) };
      }
      const current = new Map<number, Record<string, unknown>>();
      for (const row of events) {
        const vaspId = Number(row.vaspId);
        const args = row.args;
        const previous = current.get(vaspId);
        if (row.event === "VaspRegistered")
          current.set(vaspId, {
            vaspId,
            status: 1,
            admin: args.admin,
            travelRuleSigner: args.travelRuleSigner,
            name: args.name,
            endpoint: args.endpoint,
            blockNumber: row.blockNumber.toString(),
          });
        else if (previous)
          current.set(vaspId, {
            ...previous,
            blockNumber: row.blockNumber.toString(),
            ...(row.event === "VaspStatusChanged" && { status: args.status }),
            ...(row.event === "VaspKeysChanged" && {
              admin: args.admin,
              travelRuleSigner: args.travelRuleSigner,
            }),
            ...(row.event === "VaspEndpointChanged" && {
              endpoint: args.endpoint,
            }),
          });
      }
      return {
        vasps: [...current.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, vasp]) => vasp),
      };
    },
    async balances(account: Address, at?: bigint) {
      const { block, indexed } = await snapshot(async (tx) => {
        const block = await anchor(tx, at);
        const indexed = await tx
          .selectDistinctOn([balancesHistory.token], {
            token: balancesHistory.token,
            balance: balancesHistory.balance,
          })
          .from(balancesHistory)
          .where(
            and(
              eq(balancesHistory.account, bytes(account)),
              lte(balancesHistory.blockNumber, block.at),
            ),
          )
          .orderBy(
            asc(balancesHistory.token),
            desc(balancesHistory.blockNumber),
            desc(balancesHistory.logIndex),
          );
        return { block, indexed };
      });
      async function tokenBalance(symbol: "tJPY" | "tUSD") {
        const token = contracts[symbol];
        const row = indexed.find((row) => row.token.equals(bytes(token)));
        const amount =
          row?.balance ??
          (block.partial
            ? await historical(() => state.balance(token, account, block.hash))
            : 0n);
        return amount.toString();
      }
      const [tJPY, tUSD] = await Promise.all([
        tokenBalance("tJPY"),
        tokenBalance("tUSD"),
      ]);
      return {
        address: account,
        blockNumber: block.at.toString(),
        balances: { tJPY, tUSD },
      };
    },
  };
}
