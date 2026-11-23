import { receiptLogAbi } from "@ledgera/abis";
import {
  type Address,
  encodeFunctionData,
  type Hex,
  type LocalAccount,
  TransactionReceiptNotFoundError,
} from "viem";
import type { GatewayStore } from "../db/store.ts";
import type { createAdmission } from "../domain/admission.ts";

type CommitPolicy = {
  address: Address;
  chainId: number;
  intervalMs: number;
  priorityFee: bigint;
  maxFee: bigint;
};

type CommitChain = {
  readContract(input: {
    address: Address;
    abi: typeof receiptLogAbi;
    functionName: "lastSeq";
  }): Promise<bigint>;
  estimateGas(input: {
    account: Address;
    to: Address;
    data: Hex;
  }): Promise<bigint>;
  getTransactionReceipt(input: { hash: Hex }): Promise<{
    blockNumber: bigint;
    blockHash: Hex;
    status: "success" | "reverted";
  }>;
};

export function createCommitter(
  client: CommitChain,
  store: Pick<
    GatewayStore,
    "pendingCommitment" | "finishCommitment" | "uncommittedHead"
  >,
  admission: Pick<ReturnType<typeof createAdmission>, "acceptCommit">,
  signer: LocalAccount,
  policy: CommitPolicy,
  now = Date.now,
) {
  let nextCommit = now() + policy.intervalMs;
  let nextCheck = 0;
  return async () => {
    if (now() < nextCheck) return;
    nextCheck = now() + 1_000;
    const pending = await store.pendingCommitment();
    if (pending) {
      if (pending.forwardStatus === "rejected") {
        await store.finishCommitment(pending.txHash, "failed", null);
      } else {
        if (pending.includedBlock === null || !pending.includedHash) return;
        try {
          const receipt = await client.getTransactionReceipt({
            hash: pending.txHash,
          });
          if (
            receipt.blockNumber !== pending.includedBlock ||
            receipt.blockHash !== pending.includedHash
          )
            return;
          await store.finishCommitment(
            pending.txHash,
            receipt.status === "success" ? "confirmed" : "failed",
            receipt.blockNumber,
          );
        } catch (error) {
          if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
          return;
        }
      }
    }
    if (now() < nextCommit) return;
    nextCommit = now() + policy.intervalMs;

    const committed = await client.readContract({
      address: policy.address,
      abi: receiptLogAbi,
      functionName: "lastSeq",
    });
    const head = await store.uncommittedHead(committed);
    if (!head) return;
    const commitment = {
      fromSeq: committed + 1n,
      toSeq: head.seq,
      headHash: head.entryHash,
    };
    const data = encodeFunctionData({
      abi: receiptLogAbi,
      functionName: "commit",
      args: [commitment.fromSeq, commitment.toSeq, commitment.headHash],
    });
    const estimate = await client.estimateGas({
      account: signer.address,
      to: policy.address,
      data,
    });
    await admission.acceptCommit({
      sender: signer.address,
      commitment,
      sign(nonce) {
        if (nonce > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error("Gateway nonce exceeds supported range");
        return signer.signTransaction({
          type: "eip1559",
          chainId: policy.chainId,
          nonce: Number(nonce),
          to: policy.address,
          data,
          gas: (13n * estimate + 9n) / 10n,
          maxFeePerGas: policy.maxFee,
          maxPriorityFeePerGas: policy.priorityFee,
        });
      },
    });
  };
}
