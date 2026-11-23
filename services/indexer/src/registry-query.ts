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
import { bytes, position, readStatus } from "./query.ts";
import type { chainState } from "./state.ts";

type Account = typeof registryAccountEvents.$inferSelect;
type Filters = {
  vaspId?: number;
  status?: number;
  registeredFromBlock?: bigint;
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

  async function contractOptions(block: Awaited<ReturnType<typeof anchor>>) {
    const options = {
      address: contracts.kycRegistry,
      blockHash: block.hash,
      requireCanonical: true,
    } as const;
    const code = await client.getCode(options);
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
        const row = await client.readContract({
          ...options,
          functionName: "getAccount",
          args: [address],
        });
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
    async accounts(filters: Filters) {
      const range = filters.registeredFromBlock;
      const { rows } = await db.execute<
        Account & { registeredBlock: string | null }
      >(sql`
        with history as (
          select *, lag(status) over (
            partition by account order by block_number, log_index
          ) as previous_status
          from indexer.registry_account_events
        ), registrations as (
          select account, max(block_number) as registered_block
          from history
          where status = 1 and (previous_status is null or previous_status = 4)
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
        order by entry.account
      `);
      return {
        accounts: rows.map((row) => ({
          ...accountView(row),
          registeredFromBlock: row.registeredBlock,
        })),
      };
    },
    async account(address: Address, at?: bigint) {
      const data = await snapshot(async (tx) => {
        const block = await anchor(tx, at);
        const query = tx
          .select()
          .from(registryAccountEvents)
          .where(
            and(
              eq(registryAccountEvents.account, bytes(address)),
              lte(registryAccountEvents.blockNumber, block.at),
            ),
          )
          .orderBy(
            desc(registryAccountEvents.blockNumber),
            desc(registryAccountEvents.logIndex),
          );
        return {
          block,
          rows: await (at === undefined ? query : query.limit(1)),
        };
      });
      const current = await accountAt(address, data.block, data.rows[0]);
      return {
        address,
        blockNumber: data.block.at.toString(),
        account: current,
        ...(at === undefined && { history: data.rows.map(accountView) }),
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
            ? await state.balance(token, account, block.hash)
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
