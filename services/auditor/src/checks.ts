import {
  hashReceiptDigest,
  hashReceiptEntry,
  type Receipt,
} from "@ledgera/shared/receipt";
import {
  type Address,
  type Hex,
  keccak256,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";

export type AuditReceipt = Receipt & {
  entryHash: Hex;
  signature: Hex;
  rawTx: Hex;
  forwardStatus: string;
  forwardError: string | null;
};

export type Position = { block: bigint; index: number; timestampMs: bigint };

export type AuditBlock = {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestampMs: bigint;
  transactions: Array<{ hash: Hex; deposit: boolean }>;
  commitments: Array<{ fromSeq: bigint; toSeq: bigint; headHash: Hex }>;
};

type AuditPolicy = {
  chainId: number;
  verifyingContract: Address;
  gatewaySigner: Address;
  genesisHash: Hex;
  inclusionDeadlineMs: bigint;
  timeToleranceMs: bigint;
};

type Evidence = Record<string, unknown>;
type CheckCode = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7";

export type Violation = {
  check: CheckCode;
  type:
    | "BAD_SIGNATURE"
    | "BROKEN_CHAIN"
    | "COMMIT_MISMATCH"
    | "ORDER_VIOLATION"
    | "NOT_INCLUDED"
    | "UNRECEIPTED_TX"
    | "RECEIPT_AFTER_INCLUSION";
  seqA?: bigint;
  seqB?: bigint;
  txHash?: Hex;
  block?: bigint;
  detail: string;
  evidence: Evidence;
};

export type Exclusion = {
  seq: bigint;
  txHash: Hex;
  reason: "SENDER_INACTIVE" | "INSUFFICIENT_FUNDS";
  block: bigint;
  evidence: Evidence;
};

type ReadSender = (
  sender: Address,
  block: Pick<AuditBlock, "number" | "hash">,
) => Promise<{ active: boolean; balance: bigint }>;

export function auditJson<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  );
}

export function orderViolation(
  earlier: { receipt: AuditReceipt; position: Position },
  later: { receipt: AuditReceipt; position: Position },
): Violation | undefined {
  const a = earlier.position;
  const b = later.position;
  if (a.block < b.block || (a.block === b.block && a.index < b.index)) return;
  return {
    check: "C4",
    type: "ORDER_VIOLATION",
    seqA: earlier.receipt.seq,
    seqB: later.receipt.seq,
    block: a.block,
    detail: "Receipts are included out of sequence",
    evidence: { earlier, later },
  };
}

export async function checkReceipt(
  receipt: AuditReceipt,
  policy: AuditPolicy,
  previous: { seq: bigint; hash: Hex },
) {
  const violations: Violation[] = [];
  const entryHash = hashReceiptEntry(receipt);
  const digest = hashReceiptDigest(policy, receipt);
  const recovered = await recoverAddress({
    hash: digest,
    signature: receipt.signature,
  }).catch(() => null);
  if (recovered?.toLowerCase() !== policy.gatewaySigner.toLowerCase()) {
    violations.push({
      check: "C1",
      type: "BAD_SIGNATURE",
      seqA: receipt.seq,
      detail: "Receipt signature does not match the Gateway signer",
      evidence: { receipt, recovered, gatewaySigner: policy.gatewaySigner },
    });
  }
  const expectedSeq = previous.seq + 1n;
  if (
    receipt.seq !== expectedSeq ||
    receipt.entryHash !== entryHash ||
    receipt.prevHash !== previous.hash
  ) {
    violations.push({
      check: "C2",
      type: "BROKEN_CHAIN",
      seqA: receipt.seq,
      detail: "Receipt sequence, entry hash, or previous hash does not match",
      evidence: {
        receipt,
        expectedSeq,
        expectedEntryHash: entryHash,
        expectedPrevHash: previous.hash,
      },
    });
  }
  return { violations, next: { seq: receipt.seq, hash: entryHash } };
}

type ExclusionProof = {
  sender: Address;
  cost: bigint;
};

async function exclusionProof(
  receipt: AuditReceipt,
): Promise<ExclusionProof | undefined> {
  if (keccak256(receipt.rawTx) !== receipt.txHash) return;
  try {
    const serializedTransaction = receipt.rawTx as TransactionSerialized;
    const decoded = parseTransaction(serializedTransaction);
    if (
      decoded.type !== "eip1559" ||
      decoded.gas === undefined ||
      decoded.maxFeePerGas === undefined
    )
      return;
    const sender = await recoverTransactionAddress({ serializedTransaction });
    if (sender.toLowerCase() !== receipt.sender.toLowerCase()) return;
    return {
      sender,
      cost: decoded.gas * decoded.maxFeePerGas + (decoded.value ?? 0n),
    };
  } catch {
    return;
  }
}

function firstBlockAt(
  blocks: readonly AuditBlock[],
  time: bigint,
  strict: boolean,
) {
  let start = 0;
  let end = blocks.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    const timestamp = blocks[middle].timestampMs;
    if (timestamp < time || (strict && timestamp === time)) start = middle + 1;
    else end = middle;
  }
  return start;
}

export async function checkInclusion(
  receipt: AuditReceipt,
  position: Position | undefined,
  blocks: readonly AuditBlock[],
  policy: Pick<AuditPolicy, "inclusionDeadlineMs" | "timeToleranceMs">,
  readSender: ReadSender,
) {
  const violations: Violation[] = [];
  if (
    position &&
    receipt.receivedAtMs > position.timestampMs + policy.timeToleranceMs
  ) {
    violations.push({
      check: "C7",
      type: "RECEIPT_AFTER_INCLUSION",
      seqA: receipt.seq,
      txHash: receipt.txHash,
      block: position.block,
      detail: "Receipt time is later than the inclusion time plus tolerance",
      evidence: { receipt, position, toleranceMs: policy.timeToleranceMs },
    });
  }
  const deadlineMs = receipt.receivedAtMs + policy.inclusionDeadlineMs;
  if (position && position.timestampMs <= deadlineMs) return { violations };

  const firstAfterDeadline = firstBlockAt(blocks, deadlineMs, true);
  if (firstAfterDeadline === blocks.length) return { violations };
  const firstAtReceipt = firstBlockAt(blocks, receipt.receivedAtMs, false);
  const start = Math.max(0, firstAtReceipt - 1);
  const proof = await exclusionProof(receipt);
  if (proof) {
    for (let index = start; index <= firstAfterDeadline; index++) {
      const block = blocks[index];
      const state = await readSender(proof.sender, block);
      if (state.active && state.balance >= proof.cost) continue;
      const exclusion: Exclusion = {
        seq: receipt.seq,
        txHash: receipt.txHash,
        block: block.number,
        reason: state.active ? "INSUFFICIENT_FUNDS" : "SENDER_INACTIVE",
        evidence: {
          block: block.number,
          blockHash: block.hash,
          ...proof,
          ...state,
        },
      };
      return { violations, exclusion };
    }
  }
  violations.push({
    check: "C5",
    type: "NOT_INCLUDED",
    seqA: receipt.seq,
    txHash: receipt.txHash,
    block: blocks[firstAfterDeadline].number,
    detail: "Transaction was absent at its L2 inclusion deadline",
    evidence: {
      receipt,
      deadlineMs,
      deadlineBlock: blocks[firstAfterDeadline].number,
      position,
    },
  });
  return { violations };
}

export async function audit(
  receipts: readonly AuditReceipt[],
  blocks: readonly AuditBlock[],
  auditStartBlock: bigint,
  policy: AuditPolicy,
  readSender: ReadSender,
  verifyReceipt = checkReceipt,
) {
  const violations: Violation[] = [];
  const exclusions: Exclusion[] = [];
  const entries: Array<{ receipt: AuditReceipt; position?: Position }> = [];
  const positions = new Map<Hex, Position>();
  const knownHashes = new Set(receipts.map((receipt) => receipt.txHash));
  const recomputed = new Map<bigint, Hex>();
  let previousReceipt = { seq: 0n, hash: policy.genesisHash };
  let previousIncluded:
    | { receipt: AuditReceipt; position: Position }
    | undefined;
  let lastCommitted = 0n;

  for (const block of blocks) {
    if (block.number < auditStartBlock) continue;
    for (const [index, transaction] of block.transactions.entries()) {
      if (transaction.deposit) continue;
      const position = {
        block: block.number,
        index,
        timestampMs: block.timestampMs,
      };
      positions.set(transaction.hash, position);
      if (!knownHashes.has(transaction.hash)) {
        violations.push({
          check: "C6",
          type: "UNRECEIPTED_TX",
          txHash: transaction.hash,
          block: block.number,
          detail: "Non-Deposit transaction is missing a Receipt",
          evidence: { transaction, position, blockHash: block.hash },
        });
      }
    }
  }
  const candidateSet = new Map<
    bigint,
    Promise<{ active: boolean; balance: bigint }>
  >();
  let cachedSender: Address | undefined;
  const readCached: ReadSender = (sender, block) => {
    if (cachedSender !== sender) {
      cachedSender = sender;
      candidateSet.clear();
    }
    let state = candidateSet.get(block.number);
    if (!state) {
      state = readSender(sender, block);
      candidateSet.set(block.number, state);
    }
    return state;
  };
  for (const receipt of receipts) {
    const checked = await verifyReceipt(receipt, policy, previousReceipt);
    previousReceipt = checked.next;
    recomputed.set(receipt.seq, checked.next.hash);
    violations.push(...checked.violations);

    const position = positions.get(receipt.txHash);
    entries.push({ receipt, position });
    if (position) {
      const included = { receipt, position };
      if (previousIncluded) {
        const order = orderViolation(previousIncluded, included);
        if (order) violations.push(order);
      }
      previousIncluded = included;
    }
    const inclusion = await checkInclusion(
      receipt,
      position,
      blocks,
      policy,
      readCached,
    );
    violations.push(...inclusion.violations);
    if (inclusion.exclusion) exclusions.push(inclusion.exclusion);
  }

  for (const block of blocks) {
    for (const commitment of block.commitments) {
      const expectedHeadHash = recomputed.get(commitment.toSeq);
      if (
        commitment.fromSeq !== lastCommitted + 1n ||
        commitment.toSeq < commitment.fromSeq ||
        commitment.headHash !== expectedHeadHash
      ) {
        violations.push({
          check: "C3",
          type: "COMMIT_MISMATCH",
          seqA: commitment.toSeq,
          block: block.number,
          detail: "On-chain commitment does not match the Receipt chain",
          evidence: {
            commitment,
            expectedFromSeq: lastCommitted + 1n,
            expectedHeadHash,
            blockHash: block.hash,
          },
        });
      }
      lastCommitted = commitment.toSeq;
    }
  }

  return { entries, violations, exclusions };
}
