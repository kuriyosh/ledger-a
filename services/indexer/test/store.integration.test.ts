import { fileURLToPath } from "node:url";
import { openDatabase } from "@ledgera/shared/db";
import { type Hex, zeroHash } from "viem";
import { expect, test } from "vitest";
import { chainStatus } from "../src/db/schema.ts";
import { IndexerStore } from "../src/db/store.ts";

const databaseUrl = process.env.TEST_INDEXER_DATABASE_URL;
const firstHash = `0x${"a".repeat(64)}` as Hex;
const secondHash = `0x${"b".repeat(64)}` as Hex;

test.skipIf(!databaseUrl)(
  "validates stored finality before rewinding rows",
  async () => {
    if (!databaseUrl)
      throw new Error("Set TEST_INDEXER_DATABASE_URL to a disposable database");
    const database = await openDatabase(
      databaseUrl,
      "indexer",
      fileURLToPath(new URL("../src/db/migrations/", import.meta.url)),
    );
    try {
      const store = new IndexerStore(database.db, 0n);
      await store.initialize();
      await expect(
        store.append(undefined, {
          number: 0n,
          hash: firstHash,
          parentHash: zeroHash,
          timestamp: 1n,
          transactions: [],
        }),
      ).resolves.toBe(true);
      const first = await store.tip();
      await expect(
        store.append(first, {
          number: 1n,
          hash: secondHash,
          parentHash: firstHash,
          timestamp: 2n,
          transactions: [],
        }),
      ).resolves.toBe(true);
      const last = await store.tip();
      if (!last) throw new Error("Expected an indexed block");
      const wrong = { number: 0n, hash: zeroHash };
      await expect(
        store.updateFinality(
          {
            unsafe: 8n,
            safe: wrong,
            finalized: wrong,
          },
          last,
        ),
      ).rejects.toThrow("does not match");
      const verified = { number: 0n, hash: firstHash };
      await expect(
        store.updateFinality(
          {
            unsafe: 8n,
            safe: verified,
            finalized: verified,
          },
          last,
        ),
      ).resolves.toBe(true);
      await expect(store.rewind(last, -1n)).rejects.toThrow("finalized block");
      expect(await store.tip()).toEqual(last);
      await expect(store.rewind(last, 0n)).resolves.toBe(true);
      const [status] = await database.db.select().from(chainStatus);
      expect(status).toMatchObject({ indexedBlock: 0n, finalizedBlock: 0n });
    } finally {
      await database.close();
    }
  },
);
