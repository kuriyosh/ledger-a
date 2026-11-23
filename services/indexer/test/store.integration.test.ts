import { fileURLToPath } from "node:url";
import { kycRegistryAbi, ledgerTokenAbi } from "@ledgera/abis";
import { openDatabase } from "@ledgera/shared/db";
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  zeroAddress,
  zeroHash,
} from "viem";
import { expect, test } from "vitest";
import {
  balancesHistory,
  chainStatus,
  tokenTransfers,
} from "../src/db/schema.ts";
import { IndexerStore } from "../src/db/store.ts";
import { decoder } from "../src/decode.ts";
import type { ChainBlock } from "../src/rpc.ts";

const databaseUrl = process.env.TEST_INDEXER_DATABASE_URL;
const firstHash = `0x${"a".repeat(64)}` as Hex;
const secondHash = `0x${"b".repeat(64)}` as Hex;

const address = (index: number) =>
  `0x${index.toString(10).padStart(40, "0")}` as Address;
const contracts = {
  kycRegistry: address(1),
  ledgerForwarder: address(2),
  travelRuleCompliance: address(3),
  tJPY: address(4),
  tUSD: address(5),
  atomicSwap: address(6),
  receiptLog: address(7),
  depositProbe: address(8),
  consortiumSafe: address(9),
};
const sender = address(11);
const beneficiary = address(12);
const refId = `0x${"d".repeat(64)}` as Hex;
type ChainLog = ChainBlock["transactions"][number]["receipt"]["logs"][number];

function event(
  abi: "token" | "registry",
  name:
    | "Transfer"
    | "TravelRuleTransfer"
    | "EnforcementEnabled"
    | "VaspEndpointChanged",
  topicArgs: Record<string, Address | number>,
  data: Hex,
) {
  const topics = encodeEventTopics({
    abi: abi === "token" ? ledgerTokenAbi : kycRegistryAbi,
    eventName: name,
    args: topicArgs,
  }).filter((value) => typeof value === "string");
  return {
    address: abi === "token" ? contracts.tUSD : contracts.kycRegistry,
    topics,
    data,
  };
}

function block(
  number: bigint,
  hash: Hex,
  parentHash: Hex,
  items: Pick<ChainLog, "address" | "topics" | "data">[],
): ChainBlock {
  const txHash = `0x${(number + 1n).toString(16).padStart(64, "0")}` as Hex;
  const position = {
    blockNumber: number,
    blockHash: hash,
    transactionIndex: 0,
  };
  return {
    number,
    hash,
    parentHash,
    timestamp: number + 1n,
    transactions: [
      {
        hash: txHash,
        ...position,
        type: 2,
        from: sender,
        to: contracts.tUSD,
        value: 0n,
        nonce: number,
        gas: 100_000n,
        input: "0x",
        receipt: {
          ...position,
          transactionHash: txHash,
          gasUsed: 21_000n,
          status: 1,
          logs: items.map((item, logIndex) => ({
            ...item,
            ...position,
            transactionHash: txHash,
            logIndex,
          })),
        },
      },
    ],
  };
}

test.skipIf(!databaseUrl)(
  "backfills stored events and balances, then rewinds only the orphaned branch",
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
        store.append(
          undefined,
          block(0n, firstHash, zeroHash, [
            {
              ...event(
                "token",
                "Transfer",
                { from: zeroAddress, to: sender },
                encodeAbiParameters([{ type: "uint256" }], [10n]),
              ),
            },
          ]),
        ),
      ).resolves.toBe(true);
      const first = await store.tip();
      await expect(
        store.append(
          first,
          block(1n, secondHash, firstHash, [
            event(
              "token",
              "Transfer",
              { from: sender, to: beneficiary },
              encodeAbiParameters([{ type: "uint256" }], [4n]),
            ),
            event(
              "token",
              "TravelRuleTransfer",
              { refId, from: sender, to: beneficiary },
              encodeAbiParameters([{ type: "uint256" }], [4n]),
            ),
            event(
              "registry",
              "EnforcementEnabled",
              { actor: sender },
              encodeAbiParameters([{ type: "uint64" }], [8n]),
            ),
            event(
              "registry",
              "VaspEndpointChanged",
              { vaspId: 1 },
              encodeAbiParameters([{ type: "string" }], ["http://vasp-a"]),
            ),
          ]),
        ),
      ).resolves.toBe(true);
      const derived = new IndexerStore(database.db, 0n, {
        decode: decoder(contracts),
        tokens: contracts,
        state: {
          balance: async () => 10n,
          registry: async () => ({
            registryVersion: 0n,
            enforcementEnabled: false,
          }),
        },
      });
      await expect(derived.backfill()).resolves.toBe(true);
      await expect(derived.backfill()).resolves.toBe(true);
      const initial = (await database.db.select().from(chainStatus))[0];
      expect(initial).toMatchObject({
        derivedBlock: 1n,
        enforcementEnabled: true,
        registryVersion: 9n,
      });
      expect(
        (await database.db.select().from(balancesHistory))
          .map((row) => row.balance)
          .sort(),
      ).toEqual([10n, 4n, 6n]);
      const changes = await database.db.select().from(tokenTransfers);
      expect(
        changes.find((row) => row.blockNumber === 1n)?.travelRuleRef,
      ).toEqual(Buffer.from(refId.slice(2), "hex"));
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
      await expect(derived.rewind(last, -1n)).rejects.toThrow(
        "finalized block",
      );
      expect(await store.tip()).toEqual(last);
      await expect(derived.rewind(last, 0n)).resolves.toBe(true);
      const [status] = await database.db.select().from(chainStatus);
      expect(status).toMatchObject({
        indexedBlock: 0n,
        finalizedBlock: 0n,
        derivedBlock: 0n,
        enforcementEnabled: false,
        registryVersion: 0n,
      });
      expect(await database.db.select().from(balancesHistory)).toEqual([
        expect.objectContaining({ blockNumber: 0n, balance: 10n }),
      ]);
    } finally {
      await database.close();
    }
  },
);
