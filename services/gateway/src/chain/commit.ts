import { receiptLogAbi } from "@ledgera/abis";
import {
  type Address,
  encodeFunctionData,
  type LocalAccount,
  TransactionReceiptNotFoundError,
} from "viem";
import type { GatewayStore } from "../db/store.ts";
import type { createAdmission } from "../domain/admission.ts";
import type { SequencerClient } from "./sequencer.ts";

type CommitPolicy = {
  address: Address;
  chainId: number;
  intervalMs: number;
  priorityFee: bigint;
  maxFee: bigint;
};

export function readCommittedSeq(client: SequencerClient, address: Address) {
  return client.readContract({
    address,
    abi: receiptLogAbi,
    functionName: "lastSeq",
  });
}

export function createCommitter(
  client: SequencerClient,
  store: GatewayStore,
  admission: ReturnType<typeof createAdmission>,
  signer: LocalAccount,
  policy: CommitPolicy,
  now = Date.now,
) {
  let nextCommit = now() + policy.intervalMs;
  return async () => {
    if (now() < nextCommit) return;
    nextCommit = now() + policy.intervalMs;
    const pending = await store.pendingCommitment();
    if (pending) {
      if (pending.forwardStatus === "rejected") {
        await store.finishCommitment(pending.txHash, "failed", null);
      } else {
        try {
          const receipt = await client.getTransactionReceipt({
            hash: pending.txHash,
          });
          await store.finishCommitment(
            pending.txHash,
            receipt.status === "success" ? "confirmed" : "failed",
            receipt.blockNumber,
          );
        } catch (error) {
          if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        }
      }
      return;
    }

    const committed = await readCommittedSeq(client, policy.address);
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
