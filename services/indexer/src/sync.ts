import { setTimeout } from "node:timers/promises";
import { logService } from "@ledgera/shared/server";
import type { IndexerStore, Position } from "./db/store.ts";
import type { indexerRpc } from "./rpc.ts";

type Chain = ReturnType<typeof indexerRpc>;
type Store = Pick<
  IndexerStore,
  "tip" | "blockAt" | "rewind" | "append" | "updateFinality"
>;

export function indexerSync(
  store: Store,
  rpc: Chain,
  start: bigint,
  interval: number,
) {
  let nextFinality = 0;

  async function newestCommon(tip: Position, latest: bigint) {
    let low = start;
    let high = tip.number < latest ? tip.number : latest;
    let match: Position | undefined;
    while (low <= high) {
      const center = (low + high) / 2n;
      const [local, remote] = await Promise.all([
        store.blockAt(center),
        rpc.header(center),
      ]);
      if (local?.hash === remote.hash) {
        match = local;
        low = center + 1n;
      } else {
        high = center - 1n;
      }
    }
    return match;
  }

  async function sync(signal?: AbortSignal) {
    const latest = await rpc.latest();
    const anchor = await rpc.header(latest);
    let indexed = await store.tip();
    if (indexed) {
      const prior = indexed;
      const sameTip =
        prior.number <= latest &&
        (prior.number === latest
          ? anchor.hash
          : (await rpc.header(prior.number)).hash) === prior.hash;
      if (!sameTip) indexed = await newestCommon(prior, latest);
      if (prior.number !== indexed?.number) {
        if ((await rpc.header(latest)).hash !== anchor.hash)
          throw new Error("L2 reorganized during ancestor search");
        if (!(await store.rewind(prior, indexed?.number ?? start - 1n))) return;
        nextFinality = 0;
      }
    }

    const first = (indexed?.number ?? start - 1n) + 1n;
    const end = latest < first + 31n ? latest : first + 31n;
    let parent = indexed?.hash;
    if (parent === undefined && first > 0n && first <= end)
      parent = (await rpc.header(first - 1n)).hash;
    for (let height = first; height <= end; ++height) {
      signal?.throwIfAborted();
      const block = await rpc.block(height);
      const canonical = height === latest ? anchor : await rpc.header(height);
      if (
        canonical.hash !== block.hash ||
        (parent && block.parentHash !== parent)
      )
        throw new Error("Block does not match the current L2 branch");
      if (!(await store.append(indexed, block))) return;
      indexed = { number: block.number, hash: block.hash };
      parent = block.hash;
    }

    if (Date.now() >= nextFinality) {
      nextFinality = Date.now() + 5_000;
      const finality = await rpc.finality(latest);
      await store.updateFinality(finality, indexed);
    }
  }

  return {
    sync,
    async run(signal: AbortSignal) {
      while (!signal.aborted) {
        try {
          await sync(signal);
        } catch (error) {
          if (!signal.aborted)
            logService("indexer", "error", "L2 scan did not advance", null, {
              reason: error instanceof Error ? error.message : "Unknown error",
            });
        }
        await setTimeout(interval, undefined, { signal }).catch(() => {});
      }
    },
  };
}
