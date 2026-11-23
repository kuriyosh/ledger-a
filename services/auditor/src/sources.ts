import { kycRegistryAbi, receiptLogAbi } from "@ledgera/abis";
import { type Deployment, defineLedgerChain } from "@ledgera/config";
import {
  type Address,
  createPublicClient,
  getAbiItem,
  getAddress,
  type Hex,
  http,
} from "viem";
import { z } from "zod";
import type { AuditBlock } from "./checks.ts";

const hash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
export const uint64 = z
  .string()
  .regex(/^\d{1,20}$/)
  .transform(BigInt)
  .refine((value) => value <= 0xffff_ffff_ffff_ffffn);
const bytes = z
  .string()
  .regex(/^0x(?:[a-fA-F0-9]{2})*$/)
  .transform((value) => value.toLowerCase() as Hex);
export const receiptSchema = z.object({
  seq: uint64.refine((value) => value > 0n),
  txHash: hash,
  sender: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .transform((value) => getAddress(value.toLowerCase())),
  receivedAtMs: uint64,
  prevHash: hash,
  entryHash: hash,
  signature: bytes,
  rawTx: bytes,
  forwardStatus: z.string(),
  forwardError: z.string().nullable(),
});
const headSchema = z.object({ seq: uint64, entryHash: hash });

export function gatewaySource(url: string) {
  async function request(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(new URL(path, url), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    if (!response.ok)
      throw new Error(`Gateway returned HTTP ${response.status}`);
    return response.json();
  }
  return {
    async head(signal: AbortSignal) {
      return headSchema.parse(await request("/v1/log/head", signal));
    },
    async page(fromSeq: bigint, signal: AbortSignal) {
      const result = await request(
        `/v1/log?fromSeq=${fromSeq}&limit=1000`,
        signal,
      );
      return z
        .object({ entries: z.array(receiptSchema).max(1000) })
        .parse(result).entries;
    },
  };
}

export function auditSource(deployment: Deployment, url: string) {
  const chain = defineLedgerChain(deployment.environment, {
    rpcUrl: url,
    devnetChainId: deployment.chainId,
  });
  const client = createPublicClient({
    chain,
    cacheTime: 0,
    transport: http(url, { timeout: 5_000, retryCount: 0 }),
  });
  const contracts = deployment.contracts;
  return {
    chainId: () => client.getChainId(),
    tip: () => client.getBlockNumber(),
    async blockHash(number: bigint) {
      return (await client.getBlock({ blockNumber: number })).hash;
    },
    async policy() {
      const block = await client.getBlock({ blockTag: "latest" });
      const common = {
        address: contracts.receiptLog,
        abi: receiptLogAbi,
        blockHash: block.hash,
        requireCanonical: true,
      } as const;
      const [gatewaySigner, genesisHash] = await Promise.all([
        client.readContract({ ...common, functionName: "gatewaySigner" }),
        client.readContract({ ...common, functionName: "genesisHash" }),
      ]);
      return {
        genesisHash,
        gatewaySigner,
        verifyingContract: contracts.receiptLog,
        chainId: deployment.chainId,
      };
    },
    async readSender(
      sender: Address,
      block: Pick<AuditBlock, "number" | "hash">,
    ) {
      const canonical = {
        blockHash: block.hash,
        requireCanonical: true,
      } as const;
      const [active, balance] = await Promise.all([
        client.readContract({
          address: contracts.kycRegistry,
          abi: kycRegistryAbi,
          functionName: "isActive",
          args: [sender],
          ...canonical,
        }),
        client.getBalance({ address: sender, ...canonical }),
      ]);
      return { active, balance };
    },
    async blocks(from: bigint, to: bigint) {
      const blocks: AuditBlock[] = [];
      for (let start = from; start <= to; start += 16n) {
        const batch = Array.from(
          { length: 16 },
          (_, i) => start + BigInt(i),
        ).filter((number) => number <= to);
        const fetched = await Promise.all(
          batch.map((blockNumber) =>
            client.getBlock({ blockNumber, includeTransactions: true }),
          ),
        );
        blocks.push(
          ...fetched.map(
            (block): AuditBlock => ({
              number: block.number,
              hash: block.hash,
              parentHash: block.parentHash,
              timestampMs: block.timestamp * 1000n,
              transactions: block.transactions.map((transaction) => ({
                hash: transaction.hash,
                deposit: transaction.typeHex === "0x7e",
              })),
              commitments: [],
            }),
          ),
        );
      }
      const byHash = new Map(blocks.map((block) => [block.hash, block]));
      const commitments = await client.getLogs({
        address: contracts.receiptLog,
        event: getAbiItem({ abi: receiptLogAbi, name: "Committed" }),
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      for (const event of commitments) {
        const block = byHash.get(event.blockHash);
        if (!block) throw new Error("L2 changed while retrieving commitments");
        const { fromSeq, toSeq, headHash } = event.args;
        block.commitments.push({ fromSeq, toSeq, headHash });
      }
      return blocks;
    },
  };
}
