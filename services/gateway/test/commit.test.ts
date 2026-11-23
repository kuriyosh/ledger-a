import { receiptLogAbi } from "@ledgera/abis";
import {
  decodeFunctionData,
  type Hex,
  parseTransaction,
  TransactionReceiptNotFoundError,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test, vi } from "vitest";
import { createCommitter } from "../src/chain/commit.ts";
import type { GatewayStore } from "../src/db/store.ts";

const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const hash: Hex = `0x${"1".repeat(64)}`;
const policy = {
  address: "0x1111111111111111111111111111111111111111",
  chainId: 31337,
  intervalMs: 30_000,
  priorityFee: 1n,
  maxFee: 10n,
} as const;

function fixture() {
  let now = 0;
  let pending: Awaited<ReturnType<GatewayStore["pendingCommitment"]>>;
  let outstanding: Awaited<ReturnType<GatewayStore["uncommittedHead"]>>;
  const lookup = vi.fn(async () => ({
    blockNumber: 10n,
    blockHash: hash,
    status: "success" as "success" | "reverted",
  }));
  const settled = vi.fn(async () => {});
  const acceptCommit = vi.fn<
    Parameters<typeof createCommitter>[2]["acceptCommit"]
  >(async ({ sign, commitment }) => {
    const tx = parseTransaction(await sign(2n));
    expect(tx.type).toBe("eip1559");
    expect(tx.nonce).toBe(2);
    expect(
      decodeFunctionData({ abi: receiptLogAbi, data: tx.data ?? "0x" }).args,
    ).toEqual([commitment.fromSeq, commitment.toSeq, commitment.headHash]);
    return {
      seq: 9n,
      txHash: zeroHash,
      sender: signer.address,
      receivedAtMs: 10n,
      signature: "0x",
      prevHash: hash,
      entryHash: zeroHash,
    };
  });
  const checkpoint = createCommitter(
    {
      readContract: vi.fn(async () => 5n),
      estimateGas: async () => 40_000n,
      getTransactionReceipt: lookup,
    },
    {
      pendingCommitment: async () => pending,
      finishCommitment: settled,
      uncommittedHead: async () => outstanding,
    },
    { acceptCommit },
    signer,
    policy,
    () => now,
  );
  return {
    checkpoint,
    acceptCommit,
    lookup,
    settled,
    clock(at: number) {
      now = at;
    },
    pending(value: typeof pending) {
      pending = value;
    },
    outstanding(value: typeof outstanding) {
      outstanding = value;
    },
  };
}

test("waits for a tracked canonical inclusion and advances the same interval", async () => {
  const control = fixture();
  control.pending({
    txHash: zeroHash,
    forwardStatus: "forwarded",
    includedBlock: null,
    includedHash: null,
  });
  control.clock(30_000);
  await control.checkpoint();
  expect(control.lookup).not.toHaveBeenCalled();
  expect(control.acceptCommit).not.toHaveBeenCalled();

  control.pending({
    txHash: zeroHash,
    forwardStatus: "forwarded",
    includedBlock: 10n,
    includedHash: zeroHash,
  });
  control.clock(31_000);
  await control.checkpoint();
  expect(control.settled).not.toHaveBeenCalled();

  control.pending({
    txHash: zeroHash,
    forwardStatus: "forwarded",
    includedBlock: 10n,
    includedHash: hash,
  });
  control.outstanding({ seq: 8n, entryHash: hash, receivedAtMs: 10n });
  control.clock(32_000);
  await control.checkpoint();
  expect(control.settled).toHaveBeenCalledExactlyOnceWith(
    zeroHash,
    "confirmed",
    10n,
  );
  expect(control.acceptCommit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      commitment: { fromSeq: 6n, toSeq: 8n, headHash: hash },
    }),
  );
});

test("checks reverted and rejected commitments without sending system-only ranges", async () => {
  const control = fixture();
  control.pending({
    txHash: zeroHash,
    forwardStatus: "forwarded",
    includedBlock: 10n,
    includedHash: hash,
  });
  control.lookup.mockRejectedValueOnce(
    new TransactionReceiptNotFoundError({ hash: zeroHash }),
  );
  await control.checkpoint();
  expect(control.settled).not.toHaveBeenCalled();
  control.lookup.mockResolvedValueOnce({
    blockNumber: 10n,
    blockHash: hash,
    status: "reverted",
  });
  control.clock(1_000);
  await control.checkpoint();
  expect(control.settled).toHaveBeenCalledWith(zeroHash, "failed", 10n);
  control.pending({
    txHash: hash,
    forwardStatus: "rejected",
    includedBlock: null,
    includedHash: null,
  });
  control.clock(30_000);
  await control.checkpoint();
  expect(control.settled).toHaveBeenCalledWith(hash, "failed", null);
  expect(control.acceptCommit).not.toHaveBeenCalled();
});
