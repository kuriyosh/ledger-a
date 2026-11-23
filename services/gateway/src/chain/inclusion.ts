import type { Hex } from "viem";
import type { GatewayStore } from "../db/store.ts";
import type { SequencerClient } from "./sequencer.ts";

type InclusionStore = Pick<
  GatewayStore,
  "trackedTip" | "trackedBlock" | "recordBlock" | "rewindBlocks"
>;
type InclusionChain = Pick<SequencerClient, "getBlock">;

export function createInclusionTracker(
  chain: InclusionChain,
  store: InclusionStore,
  start: bigint,
  now = Date.now,
) {
  let nextPoll = 0;
  return async () => {
    if (now() < nextPoll) return;
    const latest = await chain.getBlock({ blockTag: "latest" });
    const priorTip = await store.trackedTip();
    let ancestor = priorTip;
    while (ancestor) {
      if (ancestor.number <= latest.number) {
        const canonical = await chain.getBlock({
          blockNumber: ancestor.number,
        });
        if (canonical.hash === ancestor.hash) break;
      }
      ancestor = await store.trackedBlock(ancestor.number - 1n);
    }
    const floor = start - 1n;
    if (priorTip && priorTip.number !== ancestor?.number) {
      await store.rewindBlocks(ancestor?.number ?? floor);
    }
    let parent: Hex | undefined = ancestor?.hash;
    for (
      let number = (ancestor?.number ?? floor) + 1n;
      number <= latest.number;
      number++
    ) {
      const block =
        number === latest.number
          ? latest
          : await chain.getBlock({ blockNumber: number });
      if (parent && block.parentHash !== parent)
        throw new Error("L2 changed during inclusion tracking");
      await store.recordBlock(number, block.hash, block.transactions);
      parent = block.hash;
    }
    nextPoll = now() + 1_000;
  };
}
