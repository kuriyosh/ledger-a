import { type Hex, TransactionNotFoundError } from "viem";
import type { GatewayStore } from "../db/store.ts";

const batchSize = 64n;
const recoveryBatchSize = 32;
const recoveryDelayMs = 4_000;

type InclusionStore = Pick<
  GatewayStore,
  | "trackedTip"
  | "trackedBlock"
  | "recordBlock"
  | "rewindBlocks"
  | "unobservedForwarded"
  | "requeueUnobserved"
  | "requeueAllUnobserved"
>;
type InclusionChain = {
  getBlock(at: { blockTag: "latest" } | { blockNumber: bigint }): Promise<{
    number: bigint;
    hash: Hex;
    parentHash: Hex;
    transactions: readonly Hex[];
  }>;
  getTransaction(input: { hash: Hex }): Promise<unknown>;
};

export function createInclusionTracker(
  chain: InclusionChain,
  store: InclusionStore,
  start: bigint,
  onForwarded: (seq: bigint) => void,
  now = Date.now,
) {
  let nextPoll = 0;
  let scanAfter = 0n;
  const floor = start - 1n;
  async function findAncestor(
    tip: Awaited<ReturnType<InclusionStore["trackedTip"]>>,
    height: bigint,
  ) {
    if (!tip) return undefined;
    if (
      tip.number <= height &&
      (await chain.getBlock({ blockNumber: tip.number })).hash === tip.hash
    )
      return tip;
    let low = start;
    let high = tip.number < height ? tip.number : height;
    let ancestor: typeof tip | undefined;
    while (low <= high) {
      const center = (low + high) / 2n;
      const stored = await store.trackedBlock(center);
      const canonical = await chain.getBlock({ blockNumber: center });
      if (stored?.hash === canonical.hash) {
        ancestor = stored;
        low = center + 1n;
      } else high = center - 1n;
    }
    return ancestor;
  }

  async function recoverForwarded() {
    const candidates = await store.unobservedForwarded(
      scanAfter,
      new Date(now() - recoveryDelayMs),
      recoveryBatchSize,
    );
    const results = await Promise.all(
      candidates.map(async (entry) => {
        try {
          await chain.getTransaction({ hash: entry.txHash });
        } catch (error) {
          if (!(error instanceof TransactionNotFoundError)) throw error;
          return entry.seq;
        }
        return undefined;
      }),
    );
    await store.requeueUnobserved(results.filter((seq) => seq !== undefined));
    scanAfter =
      candidates.length === recoveryBatchSize
        ? (candidates.at(-1)?.seq ?? 0n)
        : 0n;
  }

  return async (leaderChanged = false) => {
    if (!leaderChanged && now() < nextPoll) return true;
    const latest = await chain.getBlock({ blockTag: "latest" });
    const priorTip = await store.trackedTip();
    const ancestor = await findAncestor(priorTip, latest.number);
    if (priorTip && priorTip.number !== ancestor?.number) {
      await store.rewindBlocks(ancestor?.number ?? floor);
      scanAfter = 0n;
    }

    const lastStored = ancestor?.number ?? floor;
    const batchEnd = lastStored + batchSize;
    const end = batchEnd < latest.number ? batchEnd : latest.number;
    let parent: Hex | undefined = ancestor?.hash;
    for (let from = lastStored + 1n; from <= end; from += 8n) {
      const heights = Array.from(
        { length: 8 },
        (_, offset) => from + BigInt(offset),
      ).filter((number) => number <= end);
      const blocks = await Promise.all(
        heights.map((blockNumber) =>
          blockNumber === latest.number
            ? latest
            : chain.getBlock({ blockNumber }),
        ),
      );
      for (const block of blocks) {
        if (parent && block.parentHash !== parent)
          throw new Error("L2 changed during inclusion tracking");
        for (const seq of await store.recordBlock(
          block.number,
          block.hash,
          block.transactions,
        )) {
          onForwarded(seq);
        }
        parent = block.hash;
      }
    }
    if (end === latest.number || latest.number < start) {
      if (leaderChanged) {
        await store.requeueAllUnobserved();
        scanAfter = 0n;
      } else {
        await recoverForwarded();
      }
      nextPoll = now() + 1_000;
      return true;
    }
    return !leaderChanged;
  };
}
