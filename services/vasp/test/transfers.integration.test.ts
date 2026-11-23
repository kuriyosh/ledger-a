import { fileURLToPath } from "node:url";
import { openDatabase } from "@ledgera/shared/db";
import { type Address, type Hex, zeroHash } from "viem";
import { expect, test } from "vitest";
import { AlertStore } from "../src/db/alerts.ts";
import { VaspStore } from "../src/db/store.ts";
import { TransferStore, transferBytes } from "../src/db/transfers.ts";
import { createWalletVault } from "../src/wallet-vault.ts";

const url = process.env.TEST_VASP_TRANSFERS_DATABASE_URL;
const sender: Address = "0x2222222222222222222222222222222222222222";
const token: Address = "0x1111111111111111111111111111111111111111";
const firstHash: Hex = `0x${"a".repeat(64)}`;
const replacement: Hex = `0x${"b".repeat(64)}`;

test.skipIf(!url)(
  "reserves one outgoing operation and rebuilds canonical incoming and outgoing records",
  async () => {
    if (!url)
      throw new Error("Set a disposable TEST_VASP_TRANSFERS_DATABASE_URL");
    const migrations = fileURLToPath(
      new URL("../src/db/migrations/", import.meta.url),
    );
    const database = await openDatabase(url, "vasp_a", migrations);
    try {
      const vault = createWalletVault(Buffer.alloc(32, 3));
      const customers = new VaspStore(database.db, "A", vault);
      const store = new TransferStore(database.db, vault);
      const owner = await customers.createCustomer({
        familyName: "fixture",
        givenName: "fixture",
        dateOfBirth: "1980-01-01",
        country: "JP",
        addressLine: "fixture",
        email: "transfer-fixture@example.invalid",
      });
      const approval = await customers.prepareRegistry(
        owner.id,
        "register",
        365,
        async () => ({ rawTx: "0x02", firstBlock: 4n }),
      );
      if (!approval) throw new Error("Expected a prepared approval");
      await customers.settleRegistry(approval, {
        success: true,
        blockNumber: 4n,
        blockHash: zeroHash,
      });
      const wallet = await store.signer(owner.id);
      const command = {
        to: sender,
        token,
        amount: 12n,
        skipChecks: false,
        submitOnRevert: true,
      };
      const results = await Promise.allSettled([
        store.create(owner.id, command),
        store.create(owner.id, command),
      ]);
      const accepted = results.find((item) => item.status === "fulfilled");
      const rejected = results.find((item) => item.status === "rejected");
      expect(rejected?.reason).toMatchObject({ code: "OPERATION_IN_PROGRESS" });
      if (!accepted) throw new Error("Expected one transfer");
      const submitted = await store.update(accepted.value, {
        status: "submitted",
        txHash: transferBytes(zeroHash),
        gatewaySeq: 3n,
      });
      if (!submitted)
        throw new Error("Expected the first update to be applied");
      expect(
        await store.update(accepted.value, { status: "failed" }),
      ).toBeUndefined();
      await store.update(submitted, {
        status: "confirmed",
        blockNumber: 10n,
        blockHash: transferBytes(firstHash),
      });

      const event = {
        from: sender,
        to: wallet.address,
        token,
        amount: 31n,
        logIndex: 1,
        txHash: zeroHash,
      };
      await store.saveBlock(
        { number: 10n, hash: firstHash, parentHash: zeroHash },
        [event],
      );
      const prior = (await store.list(owner.id, 10)).find(
        (item) => item.direction === "in",
      );
      expect(prior?.status).toBe("confirmed");
      const alerts = new AlertStore(database.db);
      const [candidate] = await alerts.candidates(undefined, 10);
      if (!candidate) throw new Error("Expected confirmed deposit to evaluate");
      await Promise.all([
        alerts.evaluated(candidate, "tUSD", ["LARGE_AMOUNT"]),
        alerts.evaluated(candidate, "tUSD", ["LARGE_AMOUNT"]),
      ]);
      const [alert] = await alerts.list(10);
      expect(await alerts.list(10)).toHaveLength(1);
      await alerts.prepare(alert.id, 1_800_000_000);
      await alerts.attach(alert.id, "p_fixture");

      await store.rewind(9n);
      expect(await store.get(owner.id, accepted.value.id)).toMatchObject({
        status: "submitted",
        blockNumber: null,
        blockHash: null,
        gatewaySeq: 3n,
      });
      expect(
        (await store.list(owner.id, 10)).find((item) => item.id === prior?.id)
          ?.status,
      ).toBe("reorged");
      await store.saveBlock(
        { number: 10n, hash: replacement, parentHash: zeroHash },
        [event],
      );
      expect(await alerts.alert(alert.id)).toMatchObject({
        status: "invalidated",
        proposalId: "p_fixture",
      });
      const [other] = await alerts.candidates(undefined, 10);
      if (!other)
        throw new Error("Expected the replacement deposit to be evaluated");
      expect(other.id).not.toBe(candidate.id);
      await alerts.evaluated(other, "tUSD", ["LARGE_AMOUNT"]);
      const inbound = (await store.list(owner.id, 10)).filter(
        (item) => item.direction === "in",
      );
      expect(inbound).toHaveLength(2);
      expect(
        inbound.find((item) => item.status === "confirmed")?.blockHash,
      ).toEqual(transferBytes(replacement));
      expect(
        inbound.find((item) => item.status === "reorged")?.blockHash,
      ).toEqual(transferBytes(firstHash));
      await store.rewind(9n);
      await store.saveBlock(
        { number: 10n, hash: firstHash, parentHash: zeroHash },
        [event],
      );
      expect(await store.get(owner.id, prior?.id ?? "")).toMatchObject({
        status: "confirmed",
        blockHash: transferBytes(firstHash),
      });
      await alerts.evaluated(candidate, "tUSD", ["LARGE_AMOUNT"]);
      expect(await alerts.list(10)).toHaveLength(2);
      const [reappeared] = await alerts.candidates(undefined, 10);
      if (!reappeared)
        throw new Error("Expected canonical evidence to be checked again");
      expect(reappeared.id).toBe(candidate.id);
      expect(reappeared.revision).toBeGreaterThan(candidate.revision);
      await alerts.evaluated(reappeared, "tUSD", ["LARGE_AMOUNT"]);
      expect((await alerts.list(10)).map((row) => row.status).sort()).toEqual([
        "invalidated",
        "invalidated",
        "open",
      ]);
      await store.saveBlock(
        { number: 4n, hash: firstHash, parentHash: zeroHash },
        [],
      );
      expect(await customers.customer(owner.id)).toMatchObject({
        kycStatus: "error",
      });
      expect(await store.orphanedWallets()).toContainEqual({
        id: owner.id,
        hash: approval.txHash,
      });
    } finally {
      await database.close();
    }
  },
);
