import {
  hashReceiptEntry,
  type Receipt,
  receiptGenesisHash,
  signReceipt,
} from "@ledgera/shared/receipt";
import {
  type Address,
  getAddress,
  type Hex,
  keccak256,
  type LocalAccount,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";

const MAX_LOW_S =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export class AdmissionError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(`ledgera: ${message}`);
    this.code = code;
    this.details = details;
  }
}

export type SignedTransaction = {
  rawTx: Hex;
  txHash: Hex;
  sender: Address;
  nonce: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  value: bigint;
};

export type SignedReceipt = Receipt & { entryHash: Hex; signature: Hex };

export type AdmissionRecord = SignedReceipt & {
  rawTx: Hex;
  nonce: bigint;
  source: "raw" | "relay" | "system";
  vaspId?: number;
};

export type ReceiptHead = Pick<
  SignedReceipt,
  "seq" | "entryHash" | "receivedAtMs"
>;

export type AdmissionPolicy = {
  chainId: number;
  verifyingContract: Address;
  fixedPriorityFee: bigint;
  gasLimit: bigint;
  queueLimit: number;
};

export type AdmissionHistory = {
  head: ReceiptHead | undefined;
  duplicate: boolean;
  lastNonce: bigint | undefined;
  queued: number;
};

export interface IntakeTransaction {
  history(sender: Address, hash: Hex): Promise<AdmissionHistory>;
  append(record: AdmissionRecord): Promise<void>;
}

export interface AdmissionStore {
  serialize<T>(action: (store: IntakeTransaction) => Promise<T>): Promise<T>;
  reject(
    source: AdmissionRecord["source"],
    error: AdmissionError,
    transaction?: SignedTransaction,
  ): Promise<void>;
}

export interface AdmissionChain {
  senderState(sender: Address): Promise<{
    eligible: boolean;
    nonce: bigint;
    balance: bigint;
    baseFee: bigint;
  }>;
}

export async function decodeTransaction(
  input: unknown,
  policy: Pick<AdmissionPolicy, "chainId" | "fixedPriorityFee" | "gasLimit">,
): Promise<SignedTransaction> {
  if (typeof input !== "string" || !/^0x(?:[a-f0-9]{2})+$/i.test(input)) {
    throw new AdmissionError("INVALID_TX", "invalid signed transaction");
  }
  const raw = input as Hex;
  let decoded: ReturnType<typeof parseTransaction>;
  let sender: Address;
  try {
    decoded = parseTransaction(raw);
    if (
      !decoded.s ||
      BigInt(decoded.s) === 0n ||
      BigInt(decoded.s) > MAX_LOW_S
    ) {
      throw new Error("Invalid transaction signature");
    }
    sender = getAddress(
      await recoverTransactionAddress({
        serializedTransaction: raw as TransactionSerialized,
      }),
    );
  } catch {
    throw new AdmissionError("INVALID_TX", "invalid signed transaction");
  }
  if (decoded.type !== "eip1559") {
    throw new AdmissionError(
      "UNSUPPORTED_TX_TYPE",
      "only EIP-1559 transactions are accepted",
    );
  }
  if (decoded.chainId !== policy.chainId) {
    throw new AdmissionError("WRONG_CHAIN_ID", "wrong chain ID");
  }
  if (decoded.maxPriorityFeePerGas !== policy.fixedPriorityFee) {
    throw new AdmissionError("PRIORITY_FEE_NOT_FIXED", "wrong priority fee");
  }
  if (decoded.gas === undefined || decoded.gas < 21_000n) {
    throw new AdmissionError(
      "INVALID_TX",
      "gas limit is below the transaction minimum",
    );
  }
  if (decoded.gas > policy.gasLimit) {
    throw new AdmissionError(
      "GAS_LIMIT_TOO_HIGH",
      "gas limit exceeds gateway limit",
    );
  }
  if (
    decoded.nonce === undefined ||
    !Number.isSafeInteger(decoded.nonce) ||
    decoded.nonce < 0 ||
    decoded.maxFeePerGas === undefined ||
    decoded.maxFeePerGas < decoded.maxPriorityFeePerGas
  ) {
    throw new AdmissionError("INVALID_TX", "invalid transaction nonce or fee");
  }
  return {
    rawTx: raw,
    txHash: keccak256(raw),
    sender,
    nonce: BigInt(decoded.nonce),
    gas: decoded.gas,
    maxFeePerGas: decoded.maxFeePerGas,
    value: decoded.value ?? 0n,
  };
}

export function createAdmission(
  store: AdmissionStore,
  chain: AdmissionChain,
  signer: LocalAccount,
  policy: AdmissionPolicy,
  now = Date.now,
) {
  const genesisHash = receiptGenesisHash(policy);
  let tail = Promise.resolve();
  return async function accept(
    input: unknown,
    source: AdmissionRecord["source"] = "raw",
    vaspId?: number,
  ): Promise<SignedReceipt> {
    let tx: SignedTransaction | undefined;
    try {
      const decoded = await decodeTransaction(input, policy);
      tx = decoded;
      const acceptNext = tail.then(() =>
        store.serialize(async (ledger) => {
          const receivedAt = BigInt(now());
          const history = await ledger.history(decoded.sender, decoded.txHash);
          if (history.duplicate) {
            throw new AdmissionError(
              "DUPLICATE_TX",
              "transaction already accepted",
            );
          }
          if (history.queued >= policy.queueLimit) {
            throw new AdmissionError(
              "SEQUENCER_UNAVAILABLE",
              "forwarding queue is full",
            );
          }

          const state = await chain.senderState(decoded.sender);
          if (
            decoded.maxFeePerGas <
            2n * state.baseFee + policy.fixedPriorityFee
          ) {
            throw new AdmissionError(
              "MAX_FEE_TOO_LOW",
              "maximum fee is too low",
            );
          }
          if (!state.eligible) {
            throw new AdmissionError(
              "SENDER_NOT_ALLOWED",
              `sender not allowed: ${decoded.sender}`,
            );
          }
          const loggedNonce = (history.lastNonce ?? -1n) + 1n;
          const expected =
            state.nonce > loggedNonce ? state.nonce : loggedNonce;
          if (decoded.nonce !== expected) {
            throw new AdmissionError(
              decoded.nonce < expected ? "NONCE_TOO_LOW" : "NONCE_GAP",
              `expected nonce ${expected}`,
              { expectedNonce: expected.toString() },
            );
          }
          if (
            state.balance <
            decoded.gas * decoded.maxFeePerGas + decoded.value
          ) {
            throw new AdmissionError(
              "INSUFFICIENT_FUNDS",
              "insufficient funds",
            );
          }

          const lastReceived = history.head?.receivedAtMs ?? 0n;
          const receipt: Receipt = {
            seq: (history.head?.seq ?? 0n) + 1n,
            txHash: decoded.txHash,
            sender: decoded.sender,
            receivedAtMs: receivedAt > lastReceived ? receivedAt : lastReceived,
            prevHash: history.head?.entryHash ?? genesisHash,
          };
          const signed = {
            ...receipt,
            entryHash: hashReceiptEntry(receipt),
            signature: await signReceipt(signer, policy, receipt),
          };
          await ledger.append({
            ...signed,
            rawTx: decoded.rawTx,
            nonce: decoded.nonce,
            source,
            vaspId,
          });
          return signed;
        }),
      );
      tail = acceptNext.then(
        () => {},
        () => {},
      );
      return await acceptNext;
    } catch (error) {
      if (error instanceof AdmissionError)
        await store.reject(source, error, tx);
      throw error;
    }
  };
}
