import { zeroHash } from "viem";
import { expect, test, vi } from "vitest";
import { indexerRpc } from "../src/rpc.ts";

const hash = `0x${"a".repeat(64)}`;
const txHash = `0x${"b".repeat(64)}`;
const address = "0x1111111111111111111111111111111111111111";
const block = {
  number: "0x1",
  hash,
  parentHash: zeroHash,
  timestamp: "0xa",
  transactions: [
    {
      hash: txHash,
      blockNumber: "0x1",
      blockHash: hash,
      transactionIndex: "0x0",
      type: "0x7e",
      from: address,
      to: address,
      value: "0x0",
      gas: "0x5208",
      input: "0x",
      mint: "0x8",
    },
  ],
};
const receipt = {
  transactionHash: txHash,
  transactionIndex: "0x0",
  blockHash: hash,
  blockNumber: "0x1",
  gasUsed: "0x5208",
  status: "0x0",
  logs: [],
};
const reply = (result: unknown) =>
  Response.json({ jsonrpc: "2.0", id: 1, result });

function clients(...responses: Response[]) {
  const request = vi.fn<typeof fetch>();
  for (const item of responses) request.mockResolvedValueOnce(item);
  return indexerRpc("http://l2.invalid", "http://l2.invalid/rollup", request);
}

test("retains OP Deposit mint and receipt status from the matching block", async () => {
  const rpc = clients(reply(block), reply([receipt]));
  await expect(rpc.block(1n)).resolves.toMatchObject({
    hash,
    number: 1n,
    transactions: [
      { hash: txHash, type: 126, mint: 8n, receipt: { status: 0 } },
    ],
  });
});

test("rejects receipts for another branch and incomplete log positions", async () => {
  const badReceipt = clients(
    reply(block),
    reply([{ ...receipt, blockHash: zeroHash }]),
  );
  await expect(badReceipt.block(1n)).rejects.toThrow("inconsistent data");
  const log = {
    blockNumber: "0x1",
    blockHash: hash,
    transactionHash: txHash,
    transactionIndex: "0x0",
    logIndex: "0x1",
    address,
    topics: [],
    data: "0x",
  };
  const incomplete = clients(
    reply(block),
    reply([{ ...receipt, logs: [log] }]),
  );
  await expect(incomplete.block(1n)).rejects.toThrow("inconsistent data");
});

test("accepts only rollup finality anchored to the L2 block hashes", async () => {
  const status = {
    unsafe_l2: { hash, number: 1 },
    safe_l2: { hash: zeroHash, number: 0 },
    finalized_l2: { hash: zeroHash, number: 0 },
  };
  const genesis = { ...block, number: "0x0", hash: zeroHash };
  const valid = clients(
    reply(status),
    reply(block),
    reply(genesis),
    reply(genesis),
    reply(block),
  );
  await expect(valid.finality(1n)).resolves.toEqual({
    unsafe: 1n,
    safe: 0n,
    finalized: 0n,
  });
  const wrong = clients(
    reply(status),
    reply(block),
    reply({ ...genesis, hash }),
    reply(genesis),
  );
  await expect(wrong.finality(1n)).rejects.toThrow("inconsistent data");
});
