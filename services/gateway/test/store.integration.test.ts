import { fileURLToPath } from "node:url";
import { openDatabase } from "@ledgera/shared/db";
import { receiptGenesisHash } from "@ledgera/shared/receipt";
import { eq, sql } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { ForwardNotifications } from "../src/chain/forwarder.ts";
import { relayRequests } from "../src/db/schema.ts";
import { GatewayStore } from "../src/db/store.ts";
import { createAdmission } from "../src/domain/admission.ts";
import { gatewayApp } from "../src/routes/gateway.ts";

const databaseUrl = process.env.TEST_GATEWAY_DATABASE_URL;
const alice = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const bob = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const policy = {
  chainId: 31337,
  verifyingContract: "0x1111111111111111111111111111111111111111" as const,
  fixedPriorityFee: 1n,
  gasLimit: 5_000_000n,
  queueLimit: 10,
};
const tx = {
  chainId: 31337,
  to: bob.address,
  gas: 21_000n,
  maxFeePerGas: 5n,
  maxPriorityFeePerGas: 1n,
  type: "eip1559",
} as const;

test.skipIf(!databaseUrl)(
  "settles dependent nonces atomically and keeps the receipt log immutable",
  async () => {
    if (!databaseUrl)
      throw new Error("Set a disposable TEST_GATEWAY_DATABASE_URL");
    const migrations = fileURLToPath(
      new URL("../src/db/migrations/", import.meta.url),
    );
    const database = await openDatabase(databaseUrl, "gateway", migrations);
    try {
      const store = new GatewayStore(database.db);
      expect(
        await store.head(),
        "the test database must be empty",
      ).toBeUndefined();
      const admission = createAdmission(
        store,
        {
          async senderState() {
            return {
              nonce: 0n,
              confirmedNonce: 0n,
              balance: 1_000_000n,
              baseFee: 1n,
              eligible: true,
            };
          },
        },
        alice,
        policy,
      );
      const first = await admission.accept(
        await alice.signTransaction({ ...tx, nonce: 0 }),
      );
      const next = await admission.accept(
        await alice.signTransaction({ ...tx, nonce: 1 }),
      );
      const independent = await admission.accept(
        await bob.signTransaction({ ...tx, nonce: 0 }),
      );

      const notifications = new ForwardNotifications();
      const outcome = notifications.wait(
        store,
        next.seq,
        AbortSignal.timeout(2_000),
      );
      const settled = await store.setForwardResult(
        first.seq,
        "rejected",
        "insufficient funds",
      );
      for (const result of settled) notifications.publish(result.seq, result);
      expect(settled.map((entry) => entry.seq)).toEqual([first.seq, next.seq]);
      expect(await outcome).toEqual({
        status: "rejected",
        error: "prior nonce rejected",
      });
      expect((await store.queued())?.seq).toBe(independent.seq);

      const replacement = await admission.accept(
        await alice.signTransaction({ ...tx, nonce: 0, value: 1n }),
      );
      expect(replacement.seq).toBe(4n);
      expect(replacement.prevHash).toBe(independent.entryHash);

      const relay = await admission.acceptRelay({
        sender: bob.address,
        vaspId: 2,
        operations: [
          { from: alice.address, to: bob.address, selector: "0x095ea7b3" },
        ],
        sign: (nonce) => bob.signTransaction({ ...tx, nonce: Number(nonce) }),
      });
      expect(relay.seq).toBe(5n);
      expect(relay.prevHash).toBe(replacement.entryHash);
      const [operation] = await database.db
        .select()
        .from(relayRequests)
        .where(eq(relayRequests.seq, relay.seq));
      expect(operation.vaspId).toBe(2);
      expect(operation.requestFrom.toString("hex")).toBe(
        alice.address.slice(2).toLowerCase(),
      );

      await expect(
        database.db.execute(
          sql`update gateway.log_entries set received_at_ms = 0 where seq = 1`,
        ),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: "Gateway receipt fields are immutable",
        }),
      });
      await expect(
        database.db.execute(sql`delete from gateway.log_entries where seq = 1`),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: "Gateway receipts are append-only",
        }),
      });

      const app = gatewayApp({
        chainId: policy.chainId,
        genesisHash: receiptGenesisHash(policy),
        store,
        accept: admission.accept,
        notifications,
        signal: new AbortController().signal,
      });
      const reply = await app.request("/v1/log?fromSeq=1");
      expect(reply.status).toBe(200);
      const { entries } = await reply.json();
      expect(
        entries.map((entry: { forwardStatus: string }) => entry.forwardStatus),
      ).toEqual(["rejected", "rejected", "queued", "queued", "queued"]);
    } finally {
      await database.close();
    }
  },
);
