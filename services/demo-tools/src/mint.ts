import { ledgerTokenAbi } from "@ledgera/abis";
import { type Deployment, defineLedgerChain } from "@ledgera/config";
import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { finalizedReplacement } from "@ledgera/shared/finalized-nonce";
import type { rawGateway } from "@ledgera/shared/raw-gateway";
import { eq } from "drizzle-orm";
import {
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  isAddress,
  keccak256,
  type LocalAccount,
  TransactionReceiptNotFoundError,
  zeroAddress,
} from "viem";
import { z } from "zod";
import { mintRequests } from "./db/schema.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>;
type Mint = typeof mintRequests.$inferSelect;
const toBytes = (value: Hex) => Buffer.from(value.slice(2), "hex");

export const mintInput = z.strictObject({
  token: z.enum(["tJPY", "tUSD"]),
  to: z
    .string()
    .refine((value) => isAddress(value), { abort: true })
    .transform((value) => getAddress(value))
    .refine((value) => value !== zeroAddress),
  amount: z
    .string()
    .regex(/^[1-9]\d{0,77}$/)
    .transform(BigInt)
    .pipe(z.bigint().max((1n << 256n) - 1n)),
});
type MintInput = z.output<typeof mintInput>;

export function mintChain(
  deployment: Deployment,
  rpc: string,
  issuer: LocalAccount,
) {
  const client = createPublicClient({
    chain: defineLedgerChain(deployment.environment, {
      rpcUrl: rpc,
      devnetChainId: deployment.chainId,
    }),
    transport: http(rpc, { retryCount: 0, timeout: 5_000 }),
  });

  return {
    latest: () => client.getBlockNumber({ cacheTime: 0 }),
    async verify() {
      if ((await client.getChainId()) !== deployment.chainId)
        throw new Error("Demo chain ID differs from the deployment");
      for (const token of ["tJPY", "tUSD"] as const)
        if (
          !(await client.readContract({
            address: deployment.contracts[token],
            abi: ledgerTokenAbi,
            functionName: "isAgent",
            args: [issuer.address],
          }))
        )
          throw new Error("Demo issuer key must be a token agent");
    },
    async build(input: MintInput) {
      const to = deployment.contracts[input.token];
      const data = encodeFunctionData({
        abi: ledgerTokenAbi,
        functionName: "mint",
        args: [input.to, input.amount],
      });
      const [head, nonce, estimatedGas] = await Promise.all([
        client.getBlock(),
        client.getTransactionCount({
          address: issuer.address,
          blockTag: "pending",
        }),
        client.estimateGas({ account: issuer.address, to, data }),
      ]);
      const minimum = 2n * (head.baseFeePerGas ?? 0n) + 1n;
      const cap = 100_000_000_000n;
      const rawTx = await issuer.signTransaction({
        chainId: deployment.chainId,
        type: "eip1559",
        to,
        data,
        nonce,
        gas: (13n * estimatedGas + 9n) / 10n,
        maxFeePerGas: minimum > cap ? minimum : cap,
        maxPriorityFeePerGas: 1n,
      });
      return {
        rawTx: toBytes(rawTx),
        txHash: toBytes(keccak256(rawTx)),
        nonce: BigInt(nonce),
        firstBlock: head.number,
      };
    },
    async receipt(hash: Hex) {
      try {
        const result = await client.getTransactionReceipt({ hash });
        if (
          (await client.getBlock({ blockNumber: result.blockNumber })).hash ===
          result.blockHash
        )
          return result;
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      }
    },
    async wait(hash: Hex) {
      await client.waitForTransactionReceipt({
        hash,
        checkReplacement: false,
        timeout: 18_000,
        pollingInterval: 500,
      });
      return this.receipt(hash);
    },
    async replaced(request: Mint) {
      return finalizedReplacement(
        {
          finalized: () =>
            client.getBlock({
              blockTag: "finalized",
              includeTransactions: true,
            }),
          body: (blockHash) =>
            client.getBlock({ blockHash, includeTransactions: true }),
          async hashAt(blockNumber) {
            return (await client.getBlock({ blockNumber })).hash;
          },
          countAt: (blockHash) =>
            client.getTransactionCount({
              address: issuer.address,
              blockHash,
              requireCanonical: true,
            }),
        },
        {
          sender: issuer.address,
          nonce: Number(request.nonce),
          txHash: bytesToHex(request.txHash),
          firstBlock: request.firstBlock,
        },
      );
    },
  };
}

export async function exclusive<T>(
  database: Database,
  lock: string,
  act: () => Promise<T>,
) {
  let result: { value: T } | undefined;
  await database.exclusive(lock, async () => {
    result = { value: await act() };
  });
  if (!result)
    throw new ServiceError(
      "DEMO_OPERATION_IN_PROGRESS",
      "Demo operation in progress",
      409,
    );
  return result.value;
}

export function mintService(
  database: Database,
  chain: ReturnType<typeof mintChain>,
  gateway: ReturnType<typeof rawGateway>,
) {
  async function settle(request: Mint) {
    const txHash = bytesToHex(request.txHash);
    const pending = () =>
      new ServiceError("MINT_PENDING", "Waiting for mint transaction", 503, {
        txHash,
      });
    const failed = () =>
      new ServiceError("MINT_FAILED", "Mint transaction failed", 422, {
        txHash,
      });
    let receipt = await chain.receipt(txHash);
    if (!receipt && request.status === "failed") throw failed();
    if (!receipt) {
      const decision = await gateway.submit({
        txHash,
        rawTx: bytesToHex(request.rawTx),
      });
      if (decision === "accepted")
        receipt = await chain.wait(txHash).catch(() => undefined);
      else receipt = await chain.receipt(txHash);
      if (!receipt) {
        if (
          decision === "rejected" ||
          (decision === "nonce_used" && (await chain.replaced(request)))
        ) {
          await database.db
            .update(mintRequests)
            .set({ status: "failed", blockHash: null })
            .where(eq(mintRequests.id, request.id));
          throw failed();
        }
        throw pending();
      }
    }
    const status = receipt.status === "success" ? "confirmed" : "failed";
    await database.db
      .update(mintRequests)
      .set({ status, blockHash: toBytes(receipt.blockHash) })
      .where(eq(mintRequests.id, request.id));
    if (status === "failed") throw failed();
    return { txHash, status };
  }

  return (key: string, input: MintInput) =>
    exclusive(database, "issuer", async () => {
      const recipient = toBytes(input.to);
      const [existing] = await database.db
        .select()
        .from(mintRequests)
        .where(eq(mintRequests.id, key));
      if (
        existing &&
        (existing.token !== input.token ||
          existing.amount !== input.amount ||
          !existing.recipient.equals(recipient))
      )
        throw new ServiceError(
          "MINT_KEY_CONFLICT",
          "Mint idempotency key has different input",
          409,
        );

      const [pending] = await database.db
        .select()
        .from(mintRequests)
        .where(eq(mintRequests.status, "pending"));
      if (pending && pending.id !== key) {
        try {
          await settle(pending);
        } catch (error) {
          if (!(error instanceof ServiceError) || error.code !== "MINT_FAILED")
            throw error;
        }
      }
      if (existing) return settle(existing);
      const [prepared] = await database.db
        .insert(mintRequests)
        .values({
          id: key,
          token: input.token,
          recipient,
          amount: input.amount,
          ...(await chain.build(input)),
        })
        .returning();
      return settle(prepared);
    });
}
