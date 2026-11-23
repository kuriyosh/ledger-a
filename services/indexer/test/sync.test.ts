import { type Hex, zeroHash } from "viem";
import { expect, test, vi } from "vitest";
import type { Header } from "../src/rpc.ts";
import { indexerSync } from "../src/sync.ts";

function branch(digits: string) {
  const blocks = new Map<bigint, Header>();
  let parentHash: Hex = zeroHash;
  for (const [index, digit] of [...digits].entries()) {
    const number = BigInt(index);
    const hash = `0x${digit.repeat(64)}` as Hex;
    blocks.set(number, { number, hash, parentHash, timestamp: 100n + number });
    parentHash = hash;
  }
  return blocks;
}

function fixture(local: string, remote: string, start = 0n) {
  const indexed = branch(local);
  const chain = branch(remote);
  for (const height of indexed.keys())
    if (height < start) indexed.delete(height);
  const head = BigInt(remote.length - 1);
  const store: Parameters<typeof indexerSync>[0] = {
    tip: vi.fn(async () => Array.from(indexed.values()).at(-1)),
    blockAt: vi.fn(async (number) => indexed.get(number)),
    rewind: vi.fn(async (_tip, ancestor) => {
      for (const height of indexed.keys())
        if (height > ancestor) indexed.delete(height);
      return true;
    }),
    append: vi.fn(async (_tip, block) => {
      indexed.set(block.number, block);
      return true;
    }),
    updateFinality: vi.fn(async () => true),
  };
  function read(height: bigint) {
    const block = chain.get(height);
    if (!block) throw new Error("Missing block");
    return block;
  }
  const header = vi.fn(async (height: bigint) => read(height));
  const rpc: Parameters<typeof indexerSync>[1] = {
    chainId: async () => 31337,
    latest: async () => head,
    header,
    block: async (height) => ({ ...read(height), transactions: [] }),
    finality: vi.fn(async () => ({
      unsafe: head,
      safe: null,
      finalized: null,
    })),
  };
  return {
    state: indexed,
    store,
    rpc,
    header,
    run: indexerSync(store, rpc, start, 1000).sync,
  };
}

test("replaces all blocks after the nearest common ancestor", async () => {
  const scenario = fixture("abcde", "abcf0");
  await scenario.run();
  expect(scenario.store.rewind).toHaveBeenCalledWith(
    expect.objectContaining({ number: 4n }),
    2n,
  );
  expect(scenario.store.append).toHaveBeenCalledTimes(2);
  expect(scenario.state.get(4n)?.hash).toBe(zeroHash);
});

test("rewinds a shortened chain and one that diverged before the configured range", async () => {
  const shortened = fixture("abcdef", "abc");
  await shortened.run();
  expect(shortened.store.rewind).toHaveBeenCalledWith(
    expect.objectContaining({ number: 5n }),
    2n,
  );
  expect(shortened.store.append).not.toHaveBeenCalled();

  const disjoint = fixture("abcdef", "abc123", 3n);
  await disjoint.run();
  expect(disjoint.store.rewind).toHaveBeenCalledWith(
    expect.objectContaining({ number: 5n }),
    2n,
  );
  expect(disjoint.store.append).toHaveBeenCalledTimes(3);
});

test("does not rewind if the remote snapshot changed or a competing writer moved the DB", async () => {
  const moved = fixture("abcde", "aaabf");
  const fresh = branch("aaabf").get(4n);
  const stale = branch("abcde").get(4n);
  if (!fresh || !stale) throw new Error("Missing fixture head");
  moved.header.mockImplementation(async (height) =>
    height === 4n ? stale : fresh,
  );
  moved.header.mockResolvedValueOnce(fresh);
  await expect(moved.run()).rejects.toThrow(
    "reorganized during ancestor search",
  );
  expect(moved.store.rewind).not.toHaveBeenCalled();

  const raced = fixture("abcde", "abcf1");
  vi.mocked(raced.store.rewind).mockResolvedValue(false);
  await raced.run();
  expect(raced.store.append).not.toHaveBeenCalled();

  const append = fixture("abc", "abcd");
  vi.mocked(append.store.append).mockResolvedValue(false);
  await append.run();
  expect(append.store.updateFinality).not.toHaveBeenCalled();
});

test("bounds safe and finalized positions to the indexed range while retaining the observed head", async () => {
  const scenario = fixture("a", "123456789abcdef0".repeat(3));
  const head = BigInt("123456789abcdef0".repeat(3).length - 1);
  const final = await scenario.rpc.header(head);
  vi.mocked(scenario.rpc.finality).mockResolvedValue({
    unsafe: head,
    safe: final,
    finalized: final,
  });
  await scenario.run();
  expect(scenario.store.updateFinality).toHaveBeenCalledWith(
    {
      unsafe: head,
      safe: expect.objectContaining({ number: 31n }),
      finalized: expect.objectContaining({ number: 31n }),
    },
    expect.objectContaining({ number: 31n }),
  );
});
