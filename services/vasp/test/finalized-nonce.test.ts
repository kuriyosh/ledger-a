import { type Hex, zeroHash } from "viem";
import { expect, test, vi } from "vitest";
import { finalizedReplacement } from "../src/finalized-nonce.ts";

const sender = "0x1111111111111111111111111111111111111111";
const expected: Hex = `0x${"a".repeat(64)}`;
const alternative: Hex = `0x${"b".repeat(64)}`;
const finalized: Hex = `0x${"c".repeat(64)}`;
const parent: Hex = `0x${"d".repeat(64)}`;
const request = {
  sender,
  nonce: 4,
  txHash: expected,
  firstBlock: 10n,
} as const;

function fixture(used: Hex = alternative) {
  const atParent = {
    number: 10n,
    hash: parent,
    parentHash: zeroHash,
    transactions: [{ from: sender, nonce: 4, hash: used }],
  } as const;
  return {
    finalized: vi.fn(async () => ({
      number: 11n,
      hash: finalized,
      parentHash: parent,
      transactions: [],
    })),
    countAt: vi.fn(async () => 5),
    body: vi.fn(async (_hash: Hex) => atParent),
    hashAt: vi.fn(async () => finalized as Hex),
  };
}

test("ignores an unused nonce and heights newer than the finalized block", async () => {
  const chain = fixture();
  chain.countAt.mockResolvedValueOnce(4);
  expect(await finalizedReplacement(chain, request)).toBe(false);
  await expect(
    finalizedReplacement(chain, { ...request, firstBlock: 12n }),
  ).resolves.toBe(false);
  expect(chain.body).not.toHaveBeenCalled();
});

test("only marks a different hash on the finalized ancestry as a replacement", async () => {
  const same = fixture(expected);
  expect(await finalizedReplacement(same, request)).toBe(false);
  const other = fixture();
  expect(await finalizedReplacement(other, request)).toBe(true);
  expect(other.countAt).toHaveBeenCalledExactlyOnceWith(finalized);
  expect(other.body).toHaveBeenCalledExactlyOnceWith(parent);
  expect(other.hashAt).toHaveBeenCalledExactlyOnceWith(11n);
});

test("does not settle when the anchor changed or a returned parent is inconsistent", async () => {
  const changed = fixture();
  changed.hashAt.mockResolvedValueOnce(zeroHash);
  expect(await finalizedReplacement(changed, request)).toBe(false);
  const fork = fixture();
  const block = await fork.body(parent);
  fork.body.mockResolvedValueOnce({
    ...block,
    hash: zeroHash as typeof parent,
  });
  expect(await finalizedReplacement(fork, request)).toBe(false);
});
