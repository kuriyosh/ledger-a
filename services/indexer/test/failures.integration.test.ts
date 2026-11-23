import { fileURLToPath } from "node:url";
import { kycRegistryAbi, ledgerForwarderAbi } from "@ledgera/abis";
import type { Deployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { asc } from "drizzle-orm";
import {
  type Address,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type Hex,
  zeroHash,
} from "viem";
import { expect, test } from "vitest";
import { transactions } from "../src/db/schema.ts";
import { IndexerStore } from "../src/db/store.ts";
import { decoder } from "../src/decode.ts";
import { failureWorker } from "../src/failures.ts";
import type { ChainBlock } from "../src/rpc.ts";

const url = process.env.TEST_INDEXER_FAILURES_DATABASE_URL;
const address = (id: number) =>
  `0x${id.toString(16).padStart(40, "0")}` as Address;
const hash = (id: number) => `0x${id.toString(16).padStart(64, "0")}` as Hex;
const deployment: Deployment = {
  environment: "anvil",
  chainId: 31337,
  auditStartBlock: 1,
  enforcementBlock: 0,
  vasps: { network: 0, a: 1, b: 2 },
  contracts: {
    atomicSwap: address(1),
    consortiumSafe: address(2),
    depositProbe: address(3),
    kycRegistry: address(4),
    ledgerForwarder: address(5),
    receiptLog: address(6),
    tJPY: address(7),
    tUSD: address(8),
    travelRuleCompliance: address(9),
  },
};
const target = deployment.contracts.kycRegistry;
const sender = address(24);
type Tx = ChainBlock["transactions"][number];
type Log = Pick<Tx["receipt"]["logs"][number], "address" | "topics" | "data">;

function registryLog(
  name: "AccountUpdated" | "EnforcementEnabled" | "VaspRegistered",
  args: Record<string, Address | number>,
  data: Hex,
): Log {
  return {
    address: target,
    topics: encodeEventTopics({
      abi: kycRegistryAbi,
      eventName: name,
      args,
    }).filter((topic) => typeof topic === "string"),
    data,
  };
}

function account(status: number, version: bigint) {
  return registryLog(
    "AccountUpdated",
    { account: sender, vaspId: 1, actor: sender },
    encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "uint8" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [1, status, 0n, version, zeroHash],
    ),
  );
}

function block(
  height: number,
  commands: Array<{ type: number; status: 0 | 1; logs?: Log[] }>,
): ChainBlock {
  const blockHash = hash(height + 2_000);
  const blockNumber = BigInt(height);
  let logIndex = 0;
  return {
    number: blockNumber,
    hash: blockHash,
    parentHash: height > 0 ? hash(height + 1_999) : zeroHash,
    timestamp: blockNumber + 10n,
    transactions: commands.map((command, transactionIndex): Tx => {
      const position = { blockHash, blockNumber, transactionIndex };
      const txHash = hash(height * 100 + transactionIndex + 1);
      return {
        ...position,
        hash: txHash,
        type: command.type,
        nonce: BigInt(transactionIndex),
        from: sender,
        to: target,
        value: 0n,
        gas: 100_000n,
        input: "0x",
        receipt: {
          ...position,
          transactionHash: txHash,
          gasUsed: 21_000n,
          status: command.status,
          logs: (command.logs ?? []).map((log) => ({
            ...log,
            ...position,
            transactionHash: txHash,
            logIndex: logIndex++,
          })),
        },
      };
    }),
  };
}

test.skipIf(!url)(
  "classifies deposits from prior transactions and advances beyond an unavailable trace batch",
  async () => {
    if (!url)
      throw new Error(
        "Set TEST_INDEXER_FAILURES_DATABASE_URL to a disposable database",
      );
    const database = await openDatabase(
      url,
      "indexer",
      fileURLToPath(new URL("../src/db/migrations/", import.meta.url)),
    );
    try {
      const store = new IndexerStore(database.db, 0n, {
        decode: decoder(deployment.contracts),
        tokens: deployment.contracts,
        state: {
          balance: async () => 0n,
          registry: async () => ({
            enforcementEnabled: true,
            registryVersion: 4n,
          }),
        },
      });
      await store.initialize();
      const first = block(0, [
        {
          type: 2,
          status: 1,
          logs: [
            registryLog(
              "VaspRegistered",
              { vaspId: 1 },
              encodeAbiParameters(
                [
                  { type: "address" },
                  { type: "address" },
                  { type: "string" },
                  { type: "string" },
                  { type: "uint64" },
                ],
                [sender, sender, "Fixture", "http://vasp-a", 2n],
              ),
            ),
            account(1, 3n),
            registryLog(
              "EnforcementEnabled",
              { actor: sender },
              encodeAbiParameters([{ type: "uint64" }], [4n]),
            ),
          ],
        },
      ]);
      const second = block(1, [
        { type: 2, status: 1, logs: [account(3, 5n)] },
        { type: 126, status: 0 },
        { type: 2, status: 1, logs: [account(1, 6n)] },
        { type: 126, status: 0 },
      ]);
      const faulted = block(
        2,
        Array.from({ length: 25 }, () => ({ type: 2, status: 0 })),
      );
      expect(await store.append(undefined, first)).toBe(true);
      expect(await store.append(await store.tip(), second)).toBe(true);
      expect(await store.append(await store.tip(), faulted)).toBe(true);
      let canonical = false;
      const upperOutput = encodeErrorResult({
        abi: ledgerForwarderAbi,
        errorName: "SignerNotAllowed",
        args: [sender],
      });
      const attempts: Hex[] = [];
      const worker = failureWorker(
        database.db,
        deployment,
        "http://127.0.0.1:1",
        {
          header: async (number) => ({
            number,
            hash: canonical ? hash(Number(number) + 2_000) : zeroHash,
            parentHash: zeroHash,
            timestamp: 0n,
          }),
          trace: async (txHash) => {
            attempts.push(txHash);
            if (BigInt(txHash) >= 201n && BigInt(txHash) < 225n)
              throw new Error("Trace unavailable");
            return {
              error: "execution reverted",
              output: upperOutput,
              calls: [{ error: "out of gas" }],
            };
          },
        },
      );
      const signal = new AbortController().signal;
      await worker.scan(signal);
      expect(attempts).toEqual([]);
      const orphaned = await database.db.select().from(transactions);
      expect(orphaned.every((row) => row.failureKind === null)).toBe(true);
      canonical = true;
      await worker.scan(signal);
      await worker.scan(signal);
      await worker.scan(signal);
      const rows = await database.db
        .select()
        .from(transactions)
        .orderBy(asc(transactions.blockNumber), asc(transactions.txIndex));
      expect(
        rows.find((row) => row.blockNumber === 1n && row.txIndex === 1),
      ).toMatchObject({
        failureKind: "SENDER_NOT_ALLOWED",
        failureDetail: { sender, accountStatus: 3 },
      });
      expect(
        rows.find((row) => row.blockNumber === 1n && row.txIndex === 3),
      ).toMatchObject({
        failureKind: "UNKNOWN",
        failureDetail: { output: "0x", error: "out of gas" },
      });
      expect(
        rows.find((row) => row.blockNumber === 2n && row.txIndex === 24)
          ?.failureKind,
      ).toBe("UNKNOWN");
      expect(
        rows.find((row) => row.blockNumber === 2n && row.txIndex === 0)
          ?.failureKind,
      ).toBeNull();
    } finally {
      await database.close();
    }
  },
);
