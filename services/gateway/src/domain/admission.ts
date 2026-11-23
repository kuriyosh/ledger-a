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
  serializeTransaction,
  type TransactionSerialized,
} from "viem";

const MAX_LOW_S =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export function isCanonicalS(value: Hex) {
  const s = BigInt(value);
  return s > 0n && s <= MAX_LOW_S;
}

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
  operations?: readonly RelayOperation[];
};

export type RelayOperation = {
  from: Address;
  to: Address;
  selector: Hex;
  nonce: bigint;
  digest: Hex;
};

type RelayClaim = { txHash: Hex; digest: Hex; rejected: boolean; seq: bigint };

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
  outstanding: readonly { nonce: bigint; cost: bigint }[];
  queued: number;
};

export interface IntakeTransaction {
  history(sender: Address, confirmedNonce: bigint): Promise<AdmissionHistory>;
  hasReceipt(hash: Hex): Promise<boolean>;
  relayClaims(operations: readonly RelayOperation[]): Promise<RelayClaim[]>;
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
    confirmedNonce: bigint;
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
    if (!decoded.s || !isCanonicalS(decoded.s)) {
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
  if (!decoded.r || !decoded.s || decoded.yParity === undefined) {
    throw new AdmissionError("INVALID_TX", "invalid transaction signature");
  }
  try {
    if (
      serializeTransaction(decoded, {
        r: decoded.r,
        s: decoded.s,
        yParity: decoded.yParity,
      }).toLowerCase() !== raw.toLowerCase()
    )
      throw new Error("Non-canonical encoding");
  } catch {
    throw new AdmissionError("INVALID_TX", "invalid transaction encoding");
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

type RelayAdmission = {
  sender: Address;
  vaspId: number;
  operations: readonly RelayOperation[];
  isReverted(hash: Hex): Promise<boolean>;
  sign(nonce: bigint): Promise<Hex>;
};

type Intake =
  | { source: "raw"; transaction: SignedTransaction }
  | { source: "relay"; relay: RelayAdmission };

export function createAdmission(
  store: AdmissionStore,
  chain: AdmissionChain,
  signer: LocalAccount,
  policy: AdmissionPolicy,
  now = Date.now,
) {
  const genesisHash = receiptGenesisHash(policy);
  let tail = Promise.resolve();

  async function submit(request: Intake): Promise<SignedReceipt> {
    let tx = request.source === "raw" ? request.transaction : undefined;
    const sender =
      request.source === "raw"
        ? request.transaction.sender
        : request.relay.sender;
    const fromSequencer = async <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return await read();
      } catch (error) {
        if (request.source !== "relay" || error instanceof AdmissionError)
          throw error;
        throw new AdmissionError(
          "SEQUENCER_UNAVAILABLE",
          "unable to read the sequencer",
        );
      }
    };
    const acceptNext = tail.then(() =>
      store.serialize(async (ledger) => {
        const receivedAt = BigInt(now());
        if (tx && (await ledger.hasReceipt(tx.txHash))) {
          throw new AdmissionError(
            "DUPLICATE_TX",
            "transaction already accepted",
          );
        }
        if (request.source === "relay") {
          const claims = await ledger.relayClaims(request.relay.operations);
          const digests = new Set(
            request.relay.operations.map((operation) => operation.digest),
          );
          for (const claim of claims) {
            if (
              digests.has(claim.digest) ||
              (!claim.rejected &&
                !(await fromSequencer(() =>
                  request.relay.isReverted(claim.txHash),
                )))
            ) {
              throw new AdmissionError(
                "DUPLICATE_TX",
                "relay request or nonce already accepted",
                {
                  txHash: claim.txHash,
                  seq: claim.seq.toString(),
                  rejected: claim.rejected,
                },
              );
            }
          }
        }
        const state = await fromSequencer(() => chain.senderState(sender));
        const history = await ledger.history(sender, state.confirmedNonce);
        if (history.queued >= policy.queueLimit) {
          throw new AdmissionError(
            "SEQUENCER_UNAVAILABLE",
            "forwarding queue is full",
          );
        }
        const accepted = new Set(
          history.outstanding.map((entry) => entry.nonce),
        );
        let expected = state.nonce;
        if (expected < state.confirmedNonce) expected = state.confirmedNonce;
        while (accepted.has(expected)) expected += 1n;

        if (request.source === "relay") {
          tx = await decodeTransaction(
            await request.relay.sign(expected),
            policy,
          );
          if (tx.sender !== sender)
            throw new Error(
              "Relay sender does not match the signed transaction",
            );
          if (await ledger.hasReceipt(tx.txHash)) {
            throw new AdmissionError(
              "DUPLICATE_TX",
              "transaction already accepted",
            );
          }
        }
        if (!tx) throw new Error("Missing signed transaction");
        if (tx.maxFeePerGas < 2n * state.baseFee + policy.fixedPriorityFee) {
          throw new AdmissionError("MAX_FEE_TOO_LOW", "maximum fee is too low");
        }
        if (!state.eligible) {
          throw new AdmissionError(
            "SENDER_NOT_ALLOWED",
            `sender not allowed: ${sender}`,
          );
        }

        if (tx.nonce !== expected) {
          throw new AdmissionError(
            tx.nonce < expected ? "NONCE_TOO_LOW" : "NONCE_GAP",
            `expected nonce ${expected}`,
            { expectedNonce: expected.toString() },
          );
        }
        const reserved = history.outstanding.reduce(
          (total, entry) => total + entry.cost,
          0n,
        );
        if (state.balance < reserved + tx.gas * tx.maxFeePerGas + tx.value) {
          throw new AdmissionError("INSUFFICIENT_FUNDS", "insufficient funds");
        }

        const lastReceived = history.head?.receivedAtMs ?? 0n;
        const receipt: Receipt = {
          seq: (history.head?.seq ?? 0n) + 1n,
          txHash: tx.txHash,
          sender: tx.sender,
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
          rawTx: tx.rawTx,
          nonce: tx.nonce,
          source: request.source,
          ...(request.source === "relay"
            ? {
                vaspId: request.relay.vaspId,
                operations: request.relay.operations,
              }
            : {}),
        });
        return signed;
      }),
    );
    tail = acceptNext.then(
      () => {},
      () => {},
    );
    try {
      return await acceptNext;
    } catch (error) {
      if (error instanceof AdmissionError)
        await store.reject(request.source, error, tx);
      throw error;
    }
  }

  return {
    async accept(input: unknown) {
      let transaction: SignedTransaction;
      try {
        transaction = await decodeTransaction(input, policy);
      } catch (error) {
        if (error instanceof AdmissionError) await store.reject("raw", error);
        throw error;
      }
      return submit({ source: "raw", transaction });
    },
    acceptRelay(relay: RelayAdmission) {
      return submit({ source: "relay", relay });
    },
  };
}
