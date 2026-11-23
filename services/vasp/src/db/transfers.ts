import { randomUUID } from "node:crypto";
import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  sql,
} from "drizzle-orm";
import { type Address, bytesToHex, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { createWalletVault } from "../wallet-vault.ts";
import {
  customers,
  processedBlocks,
  quotesIssued,
  swaps,
  transfers,
  travelRuleMessages,
  wallets,
} from "./schema.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type Vault = ReturnType<typeof createWalletVault>;

export type Transfer = typeof transfers.$inferSelect;
export type ForwardPayload = NonNullable<Transfer["forwardRequest"]>;
export type TransferCommand = {
  to: Address;
  token: Address;
  amount: bigint;
  beneficiaryName?: Transfer["beneficiaryName"];
  skipChecks: boolean;
  submitOnRevert: boolean;
};
type TransferChange = Partial<
  Pick<
    typeof transfers.$inferInsert,
    | "status"
    | "counterpartyVaspId"
    | "refId"
    | "txHash"
    | "blockNumber"
    | "blockHash"
    | "logIndex"
    | "gatewaySeq"
    | "forwardRequest"
    | "forwardNonce"
    | "forwardFirstBlock"
    | "gatewayTxHash"
    | "firstGatewaySeq"
    | "simulationError"
    | "errorCode"
  >
>;
export type IncomingTransfer = {
  from: Address;
  to: Address;
  token: Address;
  amount: bigint;
  txHash: Hex;
  logIndex: number;
  refId?: Hex;
};
export type TransferBlock = { number: bigint; hash: Hex; parentHash: Hex };

export const transferBytes = (value: Hex) => Buffer.from(value.slice(2), "hex");
const transferId = () => `tr_${randomUUID().replaceAll("-", "")}`;
const active = ["created", "tr_pending", "tr_approved", "submitted"] as const;
export const walletLock = (customerId: string) =>
  sql`select pg_advisory_xact_lock(hashtext(current_schema() || ':wallet:' || ${customerId}))`;

export async function findWalletOperation(
  db: Pick<Database, "select">,
  customerId: string,
) {
  const [transfer] = await db
    .select({ id: transfers.id })
    .from(transfers)
    .where(
      and(
        eq(transfers.customerId, customerId),
        eq(transfers.direction, "out"),
        inArray(transfers.status, active),
      ),
    )
    .limit(1);
  if (transfer) return transfer;
  const [swap] = await db
    .select({ id: swaps.id })
    .from(swaps)
    .where(and(eq(swaps.customerId, customerId), eq(swaps.status, "submitted")))
    .limit(1);
  return swap;
}

export function transferJson(row: Transfer, tokenSymbol: string) {
  return {
    id: row.id,
    direction: row.direction,
    counterpartyAddress: getAddress(bytesToHex(row.counterpartyAddress)),
    counterpartyVaspId: row.counterpartyVaspId,
    token: tokenSymbol,
    amount: row.amount.toString(),
    status: row.status,
    refId: row.refId && bytesToHex(row.refId),
    txHash: row.txHash && bytesToHex(row.txHash),
    blockNumber: row.blockNumber?.toString() ?? null,
    blockHash: row.blockHash && bytesToHex(row.blockHash),
    logIndex: row.logIndex,
    gatewaySeq: row.gatewaySeq?.toString() ?? null,
    gatewayTxHash: row.gatewayTxHash && bytesToHex(row.gatewayTxHash),
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class TransferStore {
  private readonly db: Database;
  private readonly vault: Vault;

  constructor(db: Database, vault: Vault) {
    this.db = db;
    this.vault = vault;
  }

  async create(customerId: string, command: TransferCommand) {
    return this.db.transaction(async (tx) => {
      await tx.execute(walletLock(customerId));
      const [customer] = await tx
        .select({ status: customers.kycStatus })
        .from(customers)
        .innerJoin(wallets, eq(wallets.customerId, customers.id))
        .where(eq(customers.id, customerId));
      if (customer?.status !== "approved") {
        throw new ServiceError(
          "KYC_REQUIRED",
          "An approved customer wallet is required",
          403,
        );
      }
      const pending = await findWalletOperation(tx, customerId);
      if (pending) {
        throw new ServiceError(
          "OPERATION_IN_PROGRESS",
          "A wallet operation is in progress",
          409,
          { id: pending.id },
        );
      }
      const [created] = await tx
        .insert(transfers)
        .values({
          id: transferId(),
          customerId,
          direction: "out",
          status: "created",
          counterpartyAddress: transferBytes(command.to),
          token: transferBytes(command.token),
          amount: command.amount,
          beneficiaryName: command.beneficiaryName,
          skipChecks: command.skipChecks,
          submitOnRevert: command.submitOnRevert,
        })
        .returning();
      return created;
    });
  }

  async list(customerId: string, limit: number) {
    return this.db
      .select()
      .from(transfers)
      .where(eq(transfers.customerId, customerId))
      .orderBy(desc(transfers.createdAt), desc(transfers.id))
      .limit(limit);
  }

  async get(customerId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(transfers)
      .where(and(eq(transfers.id, id), eq(transfers.customerId, customerId)));
    if (!row)
      throw new ServiceError("TRANSFER_NOT_FOUND", "Transfer not found", 404);
    return row;
  }

  async signer(customerId: string) {
    const [wallet] = await this.db
      .select()
      .from(wallets)
      .where(eq(wallets.customerId, customerId));
    if (!wallet) throw new Error("Customer wallet is missing");
    const address = getAddress(bytesToHex(wallet.address));
    return privateKeyToAccount(
      this.vault.recover(customerId, address, wallet.encryptedPrivateKey),
    );
  }

  async pending(after: string | undefined, limit: number) {
    return this.db
      .select()
      .from(transfers)
      .where(
        and(
          eq(transfers.direction, "out"),
          inArray(transfers.status, [
            "created",
            "tr_pending",
            "tr_approved",
            "submitted",
          ]),
          after === undefined ? undefined : gt(transfers.id, after),
        ),
      )
      .orderBy(asc(transfers.id))
      .limit(limit);
  }

  async update(row: Transfer, change: TransferChange) {
    const [updated] = await this.db
      .update(transfers)
      .set({ ...change, updatedAt: new Date(), revision: row.revision + 1 })
      .where(
        and(
          eq(transfers.id, row.id),
          eq(transfers.status, row.status),
          eq(transfers.revision, row.revision),
        ),
      )
      .returning();
    return updated as Transfer | undefined;
  }

  async trackedTip() {
    const rows = await this.db
      .select()
      .from(processedBlocks)
      .orderBy(desc(processedBlocks.number))
      .limit(1);
    const row = rows.at(0);
    return row && { number: row.number, hash: bytesToHex(row.hash) };
  }

  async trackedBlock(number: bigint) {
    const [row] = await this.db
      .select()
      .from(processedBlocks)
      .where(eq(processedBlocks.number, number));
    return row ? { number: row.number, hash: bytesToHex(row.hash) } : undefined;
  }

  async saveBlock(
    block: TransferBlock,
    events: IncomingTransfer[],
    fills: Array<{ quoteHash: Hex; transactionHash: Hex }> = [],
  ) {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(processedBlocks)
        .values({ number: block.number, hash: transferBytes(block.hash) });
      const walletsOrphaned = await tx
        .update(wallets)
        .set({ registeredBlockNumber: null, registeredBlockHash: null })
        .where(
          and(
            eq(wallets.registeredBlockNumber, block.number),
            ne(wallets.registeredBlockHash, transferBytes(block.hash)),
          ),
        )
        .returning({ id: wallets.customerId });
      if (walletsOrphaned.length)
        await tx
          .update(customers)
          .set({ kycStatus: "error", updatedAt: new Date() })
          .where(
            and(
              eq(customers.kycStatus, "approved"),
              inArray(
                customers.id,
                walletsOrphaned.map(({ id }) => id),
              ),
            ),
          );
      for (const fill of fills) {
        await tx
          .update(quotesIssued)
          .set({
            filledTxHash: transferBytes(fill.transactionHash),
            filledBlockNumber: block.number,
          })
          .where(eq(quotesIssued.quoteHash, transferBytes(fill.quoteHash)));
      }
      if (!events.length) return;
      const addresses = [
        ...new Set(events.map((event) => event.to.toLowerCase() as Address)),
      ];
      const registered = await tx
        .select({ id: wallets.customerId, address: wallets.address })
        .from(wallets)
        .where(inArray(wallets.address, addresses.map(transferBytes)));
      const byAddress = new Map(
        registered.map(({ address, id }) => [bytesToHex(address), id]),
      );
      const refs = events.flatMap((event) =>
        event.refId ? [transferBytes(event.refId)] : [],
      );
      const messages =
        refs.length === 0
          ? []
          : await tx
              .select({
                refId: travelRuleMessages.refId,
                vaspId: travelRuleMessages.counterpartyVaspId,
              })
              .from(travelRuleMessages)
              .where(
                and(
                  eq(travelRuleMessages.direction, "in"),
                  eq(travelRuleMessages.status, "approved"),
                  inArray(travelRuleMessages.refId, refs),
                ),
              );
      const peers = new Map(
        messages.map(({ refId, vaspId }) => [bytesToHex(refId), vaspId]),
      );
      const rows = events.flatMap((event) => {
        const id = byAddress.get(event.to.toLowerCase() as Address);
        if (!id) return [];
        return [
          {
            id: transferId(),
            customerId: id,
            direction: "in" as const,
            counterpartyAddress: transferBytes(event.from),
            counterpartyVaspId: event.refId
              ? peers.get(event.refId)
              : undefined,
            token: transferBytes(event.token),
            amount: event.amount,
            status: "confirmed" as const,
            txHash: transferBytes(event.txHash),
            blockNumber: block.number,
            blockHash: transferBytes(block.hash),
            logIndex: event.logIndex,
            refId: event.refId && transferBytes(event.refId),
          },
        ];
      });
      if (rows.length)
        await tx
          .insert(transfers)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              transfers.txHash,
              transfers.blockHash,
              transfers.logIndex,
              transfers.customerId,
            ],
            targetWhere: sql`${transfers.direction} = 'in'`,
            set: { status: "confirmed", updatedAt: new Date() },
            setWhere: eq(transfers.status, "reorged"),
          });
      for (const row of rows) {
        if (!row.refId) continue;
        await tx
          .update(travelRuleMessages)
          .set({ txHash: row.txHash })
          .where(
            and(
              eq(travelRuleMessages.refId, row.refId),
              eq(travelRuleMessages.direction, "in"),
              eq(travelRuleMessages.status, "approved"),
            ),
          );
      }
    });
  }

  async rewind(ancestor: bigint) {
    await this.db.transaction(async (tx) => {
      const blockRemoved = gt(transfers.blockNumber, ancestor);
      await tx
        .update(travelRuleMessages)
        .set({ txHash: null })
        .where(
          and(
            eq(travelRuleMessages.direction, "in"),
            inArray(
              travelRuleMessages.refId,
              tx
                .select({ refId: transfers.refId })
                .from(transfers)
                .where(
                  and(
                    eq(transfers.direction, "in"),
                    eq(transfers.status, "confirmed"),
                    blockRemoved,
                  ),
                ),
            ),
          ),
        );
      await tx
        .update(transfers)
        .set({ status: "reorged", updatedAt: new Date() })
        .where(
          and(
            eq(transfers.direction, "in"),
            eq(transfers.status, "confirmed"),
            blockRemoved,
          ),
        );
      await tx
        .update(transfers)
        .set({
          status: "submitted",
          blockNumber: null,
          blockHash: null,
          logIndex: null,
          txHash: sql`coalesce(${transfers.gatewayTxHash}, ${transfers.txHash})`,
          errorCode: null,
          revision: sql`${transfers.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(transfers.direction, "out"),
            inArray(transfers.status, ["confirmed", "submitted", "failed"]),
            blockRemoved,
          ),
        );
      await tx
        .update(swaps)
        .set({
          status: "submitted",
          txHash: sql`coalesce(${swaps.gatewayTxHash}, ${swaps.txHash})`,
          blockNumber: null,
          blockHash: null,
          errorCode: null,
          revision: sql`${swaps.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(swaps.status, ["confirmed", "failed", "submitted"]),
            gt(swaps.blockNumber, ancestor),
          ),
        );
      await tx
        .update(quotesIssued)
        .set({ filledTxHash: null, filledBlockNumber: null })
        .where(gt(quotesIssued.filledBlockNumber, ancestor));
      const walletsOrphaned = await tx
        .update(wallets)
        .set({ registeredBlockNumber: null, registeredBlockHash: null })
        .where(gt(wallets.registeredBlockNumber, ancestor))
        .returning({ id: wallets.customerId });
      if (walletsOrphaned.length) {
        await tx
          .update(customers)
          .set({ kycStatus: "error", updatedAt: new Date() })
          .where(
            and(
              eq(customers.kycStatus, "approved"),
              inArray(
                customers.id,
                walletsOrphaned.map(({ id }) => id),
              ),
            ),
          );
      }
      await tx
        .delete(processedBlocks)
        .where(gt(processedBlocks.number, ancestor));
    });
  }

  async prune(finalized: bigint) {
    await this.db
      .delete(processedBlocks)
      .where(lt(processedBlocks.number, finalized));
  }

  async orphanedWallets() {
    const rows = await this.db
      .select({ id: wallets.customerId, hash: wallets.registeredTxHash })
      .from(wallets)
      .innerJoin(customers, eq(wallets.customerId, customers.id))
      .where(
        and(
          isNull(wallets.registeredBlockNumber),
          eq(customers.kycStatus, "error"),
        ),
      );
    return rows.flatMap((row) =>
      row.hash ? [{ id: row.id, hash: bytesToHex(row.hash) }] : [],
    );
  }

  async restoreWallet(
    id: string,
    hash: Hex,
    position: { blockNumber: bigint; blockHash: Hex },
  ) {
    await this.db.transaction(async (tx) => {
      const changed = await tx
        .update(wallets)
        .set({
          registeredBlockNumber: position.blockNumber,
          registeredBlockHash: transferBytes(position.blockHash),
        })
        .where(
          and(
            eq(wallets.customerId, id),
            eq(wallets.registeredTxHash, transferBytes(hash)),
            isNull(wallets.registeredBlockNumber),
          ),
        )
        .returning({ id: wallets.customerId });
      if (changed.length)
        await tx
          .update(customers)
          .set({ kycStatus: "approved", updatedAt: new Date() })
          .where(and(eq(customers.id, id), eq(customers.kycStatus, "error")));
    });
  }
}
