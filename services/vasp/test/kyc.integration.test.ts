import { fileURLToPath } from "node:url";
import { openDatabase } from "@ledgera/shared/db";
import { eq } from "drizzle-orm";
import { type Hex, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { customerService } from "../src/customers.ts";
import { wallets } from "../src/db/schema.ts";
import { VaspStore } from "../src/db/store.ts";
import { createWalletVault } from "../src/wallet-vault.ts";

const connection = process.env.TEST_VASP_DATABASE_URL;
const admin = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const person = {
  familyName: "検証",
  givenName: "花子",
  dateOfBirth: "1980-02-01",
  country: "JP",
  addressLine: "東京都千代田区",
  email: "test@example.invalid",
};

test.skipIf(!connection)(
  "isolates the two VASPs and retries an uncertain registration with the same wallet and transaction",
  async () => {
    if (!connection) throw new Error("Set a disposable TEST_VASP_DATABASE_URL");
    const migrations = fileURLToPath(
      new URL("../src/db/migrations/", import.meta.url),
    );
    const a = await openDatabase(connection, "vasp_a", migrations);
    const b = await openDatabase(connection, "vasp_b", migrations);
    try {
      const vault = createWalletVault(Buffer.alloc(32, 8));
      const store = new VaspStore(a.db, "A", vault);
      const other = new VaspStore(
        b.db,
        "B",
        createWalletVault(Buffer.alloc(32, 9)),
      );
      expect(await store.listCustomers()).toEqual([]);
      const first = await store.createCustomer(person);
      const second = await other.createCustomer(person);
      expect(first).toEqual({ id: "A-000001", kycStatus: "pending" });
      expect(second).toEqual({ id: "B-000001", kycStatus: "pending" });
      await expect(store.createCustomer(person)).rejects.toMatchObject({
        code: "CUSTOMER_EXISTS",
      });
      const login = await store.startSession(person.email);
      expect(await store.sessionCustomer(login.token)).toBe(first.id);
      expect(await other.sessionCustomer(login.token)).toBeUndefined();
      expect(
        await store.sessionCustomer(login.token, login.expiresAt),
      ).toBeUndefined();

      let signed = 0;
      let tried = 0;
      let oldHash: Hex | undefined;
      let mined = false;
      const chain = {
        async build(_: string, address: Hex) {
          return admin.signTransaction({
            chainId: 31337,
            type: "eip1559",
            nonce: signed++,
            to: address,
            gas: 30_000n,
            maxFeePerGas: 10n,
            maxPriorityFeePerGas: 1n,
          });
        },
        async receipt() {
          if (mined)
            return { success: true, blockNumber: 14n, blockHash: zeroHash };
        },
        async wait() {
          throw new Error("wire timeout");
        },
      };
      const gateway = {
        async submit(tx: { txHash: Hex }) {
          tried++;
          oldHash = tx.txHash;
          return "accepted" as const;
        },
      };
      await expect(
        customerService(store, chain, gateway, 365).mutate(
          first.id,
          "register",
        ),
      ).rejects.toMatchObject({ code: "REGISTRY_PENDING" });
      const stored = await store.customer(first.id);
      expect(stored.address).toBeTruthy();
      expect(stored.kycStatus).toBe("pending");

      const restarted = new VaspStore(a.db, "A", vault);
      mined = true;
      const updated = await customerService(
        restarted,
        chain,
        gateway,
        365,
      ).mutate(first.id, "register");
      expect(updated.customer.kycStatus).toBe("approved");
      expect(updated.customer.address).toBe(stored.address);
      expect(updated.txHash).toBe(oldHash);
      expect(signed).toBe(1);
      expect(tried).toBe(1);
      const [wallet] = await a.db
        .select()
        .from(wallets)
        .where(eq(wallets.customerId, first.id));
      expect(wallet.registeredBlockNumber).toBe(14n);
      if (!updated.customer.address)
        throw new Error("Approved customer has no address");
      expect(
        privateKeyToAccount(
          vault.recover(
            first.id,
            updated.customer.address,
            wallet.encryptedPrivateKey,
          ),
        ).address,
      ).toBe(updated.customer.address);
      expect(await other.customer(second.id)).toMatchObject({
        kycStatus: "pending",
        address: null,
      });
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  },
);
