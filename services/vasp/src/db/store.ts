import { createHash, randomBytes } from "node:crypto";
import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  type Address,
  bytesToHex,
  getAddress,
  type Hex,
  keccak256,
} from "viem";
import type { createWalletVault } from "../wallet-vault.ts";
import { customers, registryRequests, sessions, wallets } from "./schema.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type StoreDb = Database | Transaction;
type Vault = ReturnType<typeof createWalletVault>;
type CustomerInput = Pick<
  typeof customers.$inferInsert,
  | "familyName"
  | "givenName"
  | "dateOfBirth"
  | "country"
  | "addressLine"
  | "email"
>;
export type RegistryAction = (typeof registryRequests.$inferSelect)["action"];
export type RegistryRequest = {
  customerId: string;
  action: RegistryAction;
  txHash: Hex;
  rawTx: Hex;
};
export type RegistryResult = {
  success: boolean;
  blockNumber: bigint;
  blockHash: Hex;
};

const registryLock = sql`select pg_advisory_xact_lock(hashtext(current_schema() || ':registry-requests'))`;
const toBuffer = (hex: Hex) => Buffer.from(hex.slice(2), "hex");
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest();
const columns = {
  id: customers.id,
  familyName: customers.familyName,
  givenName: customers.givenName,
  dateOfBirth: customers.dateOfBirth,
  country: customers.country,
  addressLine: customers.addressLine,
  email: customers.email,
  kycStatus: customers.kycStatus,
  createdAt: customers.createdAt,
  updatedAt: customers.updatedAt,
  walletAddress: wallets.address,
};

function view<Row extends { walletAddress: Buffer | null }>({
  walletAddress,
  ...customer
}: Row) {
  return {
    ...customer,
    address: walletAddress ? getAddress(bytesToHex(walletAddress)) : null,
  };
}

function loadCustomers(db: StoreDb) {
  return db
    .select(columns)
    .from(customers)
    .leftJoin(wallets, eq(customers.id, wallets.customerId));
}

async function loadCustomer(db: StoreDb, customerId: string) {
  const [row] = await loadCustomers(db).where(eq(customers.id, customerId));
  if (!row)
    throw new ServiceError("CUSTOMER_NOT_FOUND", "Customer not found", 404);
  return view(row);
}

function request(row: typeof registryRequests.$inferSelect): RegistryRequest {
  return {
    customerId: row.customerId,
    action: row.action,
    txHash: bytesToHex(row.txHash),
    rawTx: bytesToHex(row.rawTx),
  };
}

export class VaspStore {
  private readonly db: Database;
  private readonly prefix: "A" | "B";
  private readonly vault: Vault;

  constructor(db: Database, prefix: "A" | "B", vault: Vault) {
    this.db = db;
    this.prefix = prefix;
    this.vault = vault;
  }

  async createCustomer(customer: CustomerInput) {
    const {
      rows: [serial],
    } = await this.db.execute<{ number: string }>(
      sql`select nextval('customer_number_seq')::text as number`,
    );
    const id = `${this.prefix}-${serial.number.padStart(6, "0")}`;
    const [inserted] = await this.db
      .insert(customers)
      .values({ id, ...customer })
      .onConflictDoNothing({ target: customers.email })
      .returning({ id: customers.id, kycStatus: customers.kycStatus });
    if (!inserted)
      throw new ServiceError(
        "CUSTOMER_EXISTS",
        "Email address already registered",
        409,
      );
    return inserted;
  }

  async startSession(email: string, now = Date.now()) {
    const [customer] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, email));
    if (!customer)
      throw new ServiceError("CUSTOMER_NOT_FOUND", "Customer not found", 404);
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(now + 86_400_000);
    await this.db.insert(sessions).values({
      customerId: customer.id,
      tokenHash: hashToken(token),
      expiresAt,
    });
    return { token, expiresAt };
  }

  async sessionCustomer(
    token: string,
    now = new Date(),
  ): Promise<string | undefined> {
    const [session] = await this.db
      .select({ id: sessions.customerId })
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token)),
          gt(sessions.expiresAt, now),
        ),
      );
    return session?.id;
  }

  customer(id: string) {
    return loadCustomer(this.db, id);
  }

  async listCustomers() {
    return (
      await loadCustomers(this.db).orderBy(
        asc(customers.createdAt),
        asc(customers.id),
      )
    ).map(view);
  }

  async addresses() {
    const rows = await this.db
      .select({
        address: wallets.address,
        id: customers.id,
        familyName: customers.familyName,
        givenName: customers.givenName,
      })
      .from(wallets)
      .innerJoin(customers, eq(wallets.customerId, customers.id))
      .where(eq(customers.kycStatus, "approved"))
      .orderBy(asc(customers.id));
    return rows.map((row) => ({
      ...row,
      address: getAddress(bytesToHex(row.address)),
    }));
  }

  async rejectCustomer(id: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(registryLock);
      const customer = await loadCustomer(tx, id);
      const [pending] = await tx
        .select({ customerId: registryRequests.customerId })
        .from(registryRequests)
        .where(eq(registryRequests.customerId, id));
      if (pending || customer.kycStatus === "approved") {
        throw new ServiceError(
          "INVALID_KYC_STATE",
          "Customer cannot be rejected in the current state",
          409,
        );
      }
      if (customer.kycStatus !== "rejected") {
        await tx
          .update(customers)
          .set({ kycStatus: "rejected", updatedAt: new Date() })
          .where(eq(customers.id, id));
      }
      return loadCustomer(tx, id);
    });
  }

  async nextRegistryRequest(): Promise<RegistryRequest | undefined> {
    const [row] = await this.db
      .select()
      .from(registryRequests)
      .orderBy(asc(registryRequests.createdAt))
      .limit(1);
    return row ? request(row) : undefined;
  }

  async prepareRegistry(
    id: string,
    action: RegistryAction,
    expiresInDays: number,
    sign: (address: Address, validUntil: Date) => Promise<Hex>,
  ): Promise<RegistryRequest | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.execute(registryLock);
      const customer = await loadCustomer(tx, id);
      const [same] = await tx
        .select()
        .from(registryRequests)
        .where(eq(registryRequests.customerId, id));
      if (same?.action === action) return request(same);
      if (action === "register" && customer.kycStatus === "approved") return;
      if (
        action === "register"
          ? customer.kycStatus === "rejected"
          : customer.kycStatus !== "approved"
      ) {
        throw new ServiceError(
          "INVALID_KYC_STATE",
          "Customer cannot perform this Registry operation",
          409,
        );
      }
      const [active] = await tx
        .select({ customerId: registryRequests.customerId })
        .from(registryRequests)
        .limit(1);
      if (active)
        throw new ServiceError(
          "REGISTRY_OPERATION_PENDING",
          "A Registry transaction is still pending",
          409,
        );

      const validUntil = new Date(
        Math.floor(Date.now() / 1000) * 1000 + expiresInDays * 86_400_000,
      );
      let address = customer.address;
      if (!address) {
        if (action !== "register")
          throw new Error("Approved customer has no wallet");
        const wallet = this.vault.create(id);
        address = wallet.address;
        await tx.insert(wallets).values({
          customerId: id,
          address: toBuffer(address),
          encryptedPrivateKey: wallet.encrypted,
          validUntil,
        });
      }
      const rawTx = await sign(address, validUntil);
      const txHash = keccak256(rawTx);
      if (action === "register") {
        await tx
          .update(wallets)
          .set({ validUntil })
          .where(eq(wallets.customerId, id));
      }
      await tx.insert(registryRequests).values({
        customerId: id,
        action,
        rawTx: toBuffer(rawTx),
        txHash: toBuffer(txHash),
      });
      return { customerId: id, action, rawTx, txHash };
    });
  }

  async settleRegistry(pending: RegistryRequest, result?: RegistryResult) {
    return this.db.transaction(async (tx) => {
      await tx.execute(registryLock);
      const [matched] = await tx
        .delete(registryRequests)
        .where(
          and(
            eq(registryRequests.customerId, pending.customerId),
            eq(registryRequests.txHash, toBuffer(pending.txHash)),
          ),
        )
        .returning({ customerId: registryRequests.customerId });
      if (matched && pending.action === "register") {
        await tx
          .update(customers)
          .set({
            kycStatus: result?.success ? "approved" : "error",
            updatedAt: new Date(),
          })
          .where(eq(customers.id, pending.customerId));
        if (result?.success) {
          await tx
            .update(wallets)
            .set({
              registeredTxHash: toBuffer(pending.txHash),
              registeredBlockNumber: result.blockNumber,
              registeredBlockHash: toBuffer(result.blockHash),
            })
            .where(eq(wallets.customerId, pending.customerId));
        }
      }
      return loadCustomer(tx, pending.customerId);
    });
  }
}
