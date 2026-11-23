import type { Address, Hex } from "viem";
import { z } from "zod";

const hexSize = (bytes: number) =>
  z
    .string()
    .length(2 + bytes * 2)
    .regex(/^0x[0-9a-fA-F]+$/);
const hash = hexSize(32).transform((value) => value.toLowerCase() as Hex);
const address = hexSize(20).transform(
  (value) => value.toLowerCase() as Address,
);
const data = z
  .string()
  .regex(/^0x(?:[a-fA-F0-9]{2})*$/)
  .transform((value) => value.toLowerCase() as Hex);
const quantity = z
  .string()
  .regex(/^0x(?:0|[1-9a-fA-F][a-fA-F0-9]{0,63})$/)
  .transform(BigInt);
const bigintColumn = quantity.pipe(z.bigint().max(0x7fff_ffff_ffff_ffffn));
const integer = quantity.pipe(z.bigint().max(0x7fff_ffffn)).transform(Number);
const transactionType = integer.pipe(z.number().max(255));

const headerSchema = z.object({
  number: bigintColumn,
  hash,
  parentHash: hash,
  timestamp: quantity.pipe(z.bigint().max(8_640_000_000_000n)),
});

const rpcTransaction = z
  .object({
    hash,
    blockNumber: bigintColumn,
    blockHash: hash,
    transactionIndex: integer,
    type: transactionType,
    from: address,
    to: address.nullable(),
    value: quantity,
    nonce: bigintColumn.optional(),
    gas: bigintColumn,
    input: data,
    mint: quantity.nullish(),
  })
  .refine((value) => value.type === 126 || value.nonce !== undefined);

const rpcLog = z.object({
  blockNumber: bigintColumn,
  blockHash: hash,
  transactionHash: hash,
  transactionIndex: integer,
  logIndex: integer,
  address,
  topics: z.array(hash).max(4),
  data,
  removed: z.literal(false).optional(),
});

const rpcReceipt = z.object({
  transactionHash: hash,
  transactionIndex: integer,
  blockNumber: bigintColumn,
  blockHash: hash,
  gasUsed: bigintColumn,
  status: integer.pipe(z.union([z.literal(0), z.literal(1)])),
  logs: z.array(rpcLog),
});

const rpcBlock = headerSchema.extend({ transactions: z.array(rpcTransaction) });
const rollupNumber = z.union([
  z.int().nonnegative().transform(BigInt),
  bigintColumn,
]);
const blockRef = z.object({ hash, number: rollupNumber });
const syncStatus = z.object({
  unsafe_l2: blockRef,
  safe_l2: blockRef,
  finalized_l2: blockRef,
});
const rpcReply = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal(1),
  result: z.unknown(),
});

export type Header = z.infer<typeof headerSchema>;
export type ChainBlock = Header & {
  transactions: Array<
    z.infer<typeof rpcTransaction> & { receipt: z.infer<typeof rpcReceipt> }
  >;
};
export type BlockRef = z.infer<typeof blockRef>;
export type Finality = {
  unsafe: bigint;
  safe: BlockRef | null;
  finalized: BlockRef | null;
};

const tag = (height: bigint) => `0x${height.toString(16)}`;

function unavailable() {
  return new Error("Indexer RPC returned incomplete or inconsistent data");
}

export function indexerRpc(l2: string, rollup: string, requestHttp = fetch) {
  async function request<T>(
    url: string,
    method: string,
    input: unknown[],
    schema: z.ZodType<T>,
  ) {
    const response = await requestHttp(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: input }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw unavailable();
    const parsed = rpcReply.safeParse(await response.json());
    if (!parsed.success) throw unavailable();
    const result = schema.safeParse(parsed.data.result);
    if (!result.success) throw unavailable();
    return result.data;
  }

  async function header(height: bigint) {
    const observed = await request(
      l2,
      "eth_getBlockByNumber",
      [tag(height), false],
      headerSchema,
    );
    if (observed.number !== height) throw unavailable();
    return observed;
  }

  return {
    chainId: () => request(l2, "eth_chainId", [], integer),
    latest: () => request(l2, "eth_blockNumber", [], bigintColumn),
    header,
    async block(height: bigint): Promise<ChainBlock> {
      const [block, receipts] = await Promise.all([
        request(l2, "eth_getBlockByNumber", [tag(height), true], rpcBlock),
        request(l2, "eth_getBlockReceipts", [tag(height)], z.array(rpcReceipt)),
      ]);
      if (
        block.number !== height ||
        block.transactions.length !== receipts.length
      )
        throw unavailable();
      const byIndex = new Map(
        receipts.map((receipt) => [receipt.transactionIndex, receipt]),
      );
      if (byIndex.size !== receipts.length) throw unavailable();
      const txHashes = new Set<Hex>();
      let expectedLog = 0;
      const transactions = block.transactions.map((transaction, index) => {
        const receipt = byIndex.get(index);
        if (
          !receipt ||
          transaction.transactionIndex !== index ||
          transaction.blockHash !== block.hash ||
          transaction.blockNumber !== height ||
          receipt.transactionHash !== transaction.hash ||
          receipt.blockHash !== block.hash ||
          receipt.blockNumber !== height ||
          txHashes.has(transaction.hash)
        )
          throw unavailable();
        txHashes.add(transaction.hash);
        for (const log of receipt.logs) {
          if (
            log.transactionHash !== transaction.hash ||
            log.transactionIndex !== index ||
            log.blockHash !== block.hash ||
            log.blockNumber !== height
          )
            throw unavailable();
          if (log.logIndex !== expectedLog++) throw unavailable();
        }
        return { ...transaction, receipt };
      });
      return { ...block, transactions };
    },
    async finality(latest: bigint): Promise<Finality> {
      if (!rollup) return { unsafe: latest, safe: null, finalized: null };
      const status = await request(
        rollup,
        "optimism_syncStatus",
        [],
        syncStatus,
      );
      const {
        unsafe_l2: unsafe,
        safe_l2: safe,
        finalized_l2: finalized,
      } = status;
      if (finalized.number > safe.number || safe.number > unsafe.number)
        throw unavailable();
      const references = [unsafe, safe, finalized];
      const anchors = await Promise.all(
        references.map((ref) => header(ref.number)),
      );
      if (
        anchors.some(
          (block, index) => block.hash !== references[index]?.hash,
        ) ||
        (await header(unsafe.number)).hash !== unsafe.hash
      )
        throw unavailable();
      return {
        unsafe: unsafe.number,
        safe,
        finalized,
      };
    },
  };
}
