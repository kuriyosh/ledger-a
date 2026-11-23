import { type Hex, numberToHex, TransactionNotFoundError } from "viem";
import { expect, test, vi } from "vitest";
import { createInclusionTracker } from "../src/chain/inclusion.ts";

const hash = (number: bigint) => numberToHex(number, { size: 32 });
function blocks(from: bigint, to: bigint, offset = 0n, parent?: Hex) {
  return Array.from({ length: Number(to - from + 1n) }, (_, i) => {
    const number = from + BigInt(i);
    return {
      number,
      hash: hash(number + offset),
      parentHash: i === 0 && parent ? parent : hash(number + offset - 1n),
      transactions: [],
    };
  });
}

function fixture(initial: ReturnType<typeof blocks>) {
  let chain = new Map(initial.map((block) => [block.number, block]));
  let current = 0;
  const tracked = new Map<bigint, { number: bigint; hash: Hex }>();
  const store = {
    async trackedTip() {
      return Array.from(tracked.values()).at(-1);
    },
    async trackedBlock(number: bigint) {
      return tracked.get(number);
    },
    async recordBlock(number: bigint, hash: Hex) {
      tracked.set(number, { number, hash });
      return [];
    },
    rewindBlocks: vi.fn(async (number: bigint) => {
      for (const key of tracked.keys()) if (key > number) tracked.delete(key);
    }),
    unobservedForwarded: vi.fn(async () => [
      { seq: 1n, txHash: hash(101n) },
      { seq: 2n, txHash: hash(102n) },
    ]),
    requeueUnobserved: vi.fn(async () => {}),
    requeueAllUnobserved: vi.fn(async () => {}),
  };
  const tracker = createInclusionTracker(
    {
      async getBlock(at) {
        const result =
          "blockNumber" in at
            ? chain.get(at.blockNumber)
            : Array.from(chain.values()).at(-1);
        if (!result) throw new Error("Block unavailable");
        return result;
      },
      async getTransaction({ hash: queried }) {
        if (queried === hash(101n))
          throw new TransactionNotFoundError({ hash: queried });
        return { hash: queried };
      },
    },
    store,
    4n,
    () => {},
    () => current,
  );
  return {
    tracked,
    tracker,
    store,
    setChain(next: ReturnType<typeof blocks>) {
      chain = new Map(next.map((block) => [block.number, block]));
      current += 1_001;
    },
  };
}

test("bounds historical catch-up and requeues only missing transactions", async () => {
  const { tracker, tracked, store } = fixture(blocks(4n, 70n));
  await tracker();
  expect(tracked.size).toBe(64);
  expect(store.unobservedForwarded).not.toHaveBeenCalled();
  await tracker();
  expect(tracked.size).toBe(67);
  expect(store.requeueUnobserved).toHaveBeenCalledWith([1n]);
});

test("rewinds a shortened replacement chain to its common ancestor", async () => {
  const { tracker, tracked, store, setChain } = fixture(blocks(4n, 10n));
  await tracker();
  setChain([...blocks(4n, 5n), ...blocks(6n, 8n, 100n, hash(5n))]);
  await tracker();
  expect(store.rewindBlocks).toHaveBeenCalledExactlyOnceWith(5n);
  expect(tracked.has(9n)).toBe(false);
  expect(tracked.get(8n)?.hash).toBe(hash(108n));
});

test("rewinds to the audit floor if the fork predates the tracked range", async () => {
  const { tracker, tracked, store, setChain } = fixture(blocks(4n, 6n));
  await tracker();
  setChain(blocks(4n, 7n, 200n));
  await tracker();
  expect(store.rewindBlocks).toHaveBeenCalledExactlyOnceWith(3n);
  expect(tracked.get(4n)?.hash).toBe(hash(204n));
});

test("rejects a parent hash change during scanning", async () => {
  const { tracker, tracked } = fixture([
    ...blocks(4n, 5n),
    ...blocks(6n, 6n, 100n),
  ]);
  await expect(tracker()).rejects.toThrow("L2 changed");
  expect(tracked.size).toBe(2);
});

test("leader change waits for the new head before requeueing forwarded transactions", async () => {
  const { tracker, tracked, store } = fixture(blocks(4n, 70n));
  expect(await tracker(true)).toBe(false);
  expect(tracked.size).toBe(64);
  expect(store.requeueAllUnobserved).not.toHaveBeenCalled();
  expect(await tracker(true)).toBe(true);
  expect(tracked.size).toBe(67);
  expect(store.requeueAllUnobserved).toHaveBeenCalledOnce();
  expect(store.unobservedForwarded).not.toHaveBeenCalled();
});
