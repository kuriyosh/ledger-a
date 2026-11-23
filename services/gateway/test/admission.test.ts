import {
  hashReceiptEntry,
  receiptGenesisHash,
  receiptTypes,
} from "@ledgera/shared/receipt";
import { type Address, type Hex, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import {
  type AdmissionError,
  type AdmissionRecord,
  type AdmissionStore,
  createAdmission,
  type IntakeTransaction,
} from "../src/domain/admission.ts";

const ALICE = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const BOB = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const POLICY = {
  chainId: 31337,
  verifyingContract: "0x1111111111111111111111111111111111111111" as const,
  fixedPriorityFee: 1n,
  gasLimit: 5_000_000n,
  queueLimit: 100,
};
const STANDARD = {
  chainId: POLICY.chainId,
  gas: 21_000n,
  maxPriorityFeePerGas: 1n,
  maxFeePerGas: 5n,
  nonce: 0,
  to: BOB.address,
  type: "eip1559",
  value: 10n,
} as const;

function fixture(initial?: {
  nonce?: bigint;
  eligible?: boolean;
  balance?: bigint;
}) {
  const entries: AdmissionRecord[] = [];
  const errors: AdmissionError[] = [];
  const store: AdmissionStore = {
    async serialize<T>(action: (transaction: IntakeTransaction) => Promise<T>) {
      return await action({
        async history(sender: Address) {
          const sameSender = entries.filter((entry) => entry.sender === sender);
          return {
            head: entries.at(-1),
            outstanding: sameSender.map((entry) => ({
              nonce: entry.nonce,
              cost: 105_010n,
            })),
            queued: entries.length,
          };
        },
        async hasReceipt(hash: Hex) {
          return entries.some((entry) => entry.txHash === hash);
        },
        async append(entry) {
          entries.push(entry);
        },
      });
    },
    async reject(_source, error) {
      errors.push(error);
    },
  };
  let timestamp = 100;
  const { accept } = createAdmission(
    store,
    {
      async senderState() {
        return {
          baseFee: 2n,
          nonce: 0n,
          confirmedNonce: 0n,
          eligible: true,
          balance: 10_000_000n,
          ...initial,
        };
      },
    },
    ALICE,
    POLICY,
    () => timestamp--,
  );
  return { accept, entries, errors };
}

describe("Gateway transaction admission", () => {
  test.each([
    ["INVALID_TX", (): string => "0x02"],
    [
      "UNSUPPORTED_TX_TYPE",
      () =>
        ALICE.signTransaction({
          chainId: POLICY.chainId,
          nonce: 0,
          gas: 21_000n,
          gasPrice: 5n,
          to: BOB.address,
          type: "legacy",
        }),
    ],
    [
      "WRONG_CHAIN_ID",
      () => ALICE.signTransaction({ ...STANDARD, chainId: 100 }),
    ],
    [
      "PRIORITY_FEE_NOT_FIXED",
      () => ALICE.signTransaction({ ...STANDARD, maxPriorityFeePerGas: 2n }),
    ],
    [
      "MAX_FEE_TOO_LOW",
      () => ALICE.signTransaction({ ...STANDARD, maxFeePerGas: 4n }),
    ],
    [
      "GAS_LIMIT_TOO_HIGH",
      () => ALICE.signTransaction({ ...STANDARD, gas: POLICY.gasLimit + 1n }),
    ],
    ["NONCE_GAP", () => ALICE.signTransaction({ ...STANDARD, nonce: 2 })],
  ] as const)("rejects %s without reserving a sequence", async (code, sign) => {
    const { accept, entries, errors } = fixture();
    await expect(accept(await sign())).rejects.toMatchObject({ code });
    expect(entries).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  test("checks the actual sender and preserves the chain across concurrent callers", async () => {
    const { accept, entries } = fixture();
    const raws = await Promise.all([
      ALICE.signTransaction(STANDARD),
      BOB.signTransaction(STANDARD),
    ]);
    const results = await Promise.all(raws.map((raw) => accept(raw)));
    expect(entries.map((entry) => entry.seq)).toEqual([1n, 2n]);
    expect(entries.map((entry) => entry.receivedAtMs)).toEqual([100n, 100n]);
    expect(new Set(entries.map((entry) => entry.sender))).toEqual(
      new Set([ALICE.address, BOB.address]),
    );
    expect(entries[0].prevHash).toBe(receiptGenesisHash(POLICY));
    expect(entries[1].prevHash).toBe(entries[0].entryHash);
    for (const receipt of results) {
      expect(receipt.entryHash).toBe(hashReceiptEntry(receipt));
      expect(
        await verifyTypedData({
          address: ALICE.address,
          domain: {
            chainId: POLICY.chainId,
            verifyingContract: POLICY.verifyingContract,
            name: "ledgerA Gateway",
            version: "1",
          },
          types: receiptTypes,
          primaryType: "Receipt",
          message: receipt,
          signature: receipt.signature,
        }),
      ).toBe(true);
    }
    await expect(accept(raws[0])).rejects.toMatchObject({
      code: "DUPLICATE_TX",
    });
    const next = await accept(
      await ALICE.signTransaction({ ...STANDARD, nonce: 1 }),
    );
    expect(next.seq).toBe(3n);
  });

  test("rejects ineligible senders, old nonces, and a balance below the full cost", async () => {
    const tx = await ALICE.signTransaction(STANDARD);
    await expect(fixture({ eligible: false }).accept(tx)).rejects.toMatchObject(
      { code: "SENDER_NOT_ALLOWED" },
    );
    await expect(fixture({ nonce: 1n }).accept(tx)).rejects.toMatchObject({
      code: "NONCE_TOO_LOW",
    });
    await expect(
      fixture({
        balance: STANDARD.gas * STANDARD.maxFeePerGas + STANDARD.value - 1n,
      }).accept(tx),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
  });

  test("rejects extra bytes after a signed transaction", async () => {
    const raw = await ALICE.signTransaction(STANDARD);
    await expect(fixture().accept(`${raw}00`)).rejects.toMatchObject({
      code: "INVALID_TX",
    });
  });

  test("reserves the full transaction cost until a sender's nonce is confirmed", async () => {
    const cost = STANDARD.gas * STANDARD.maxFeePerGas + STANDARD.value;
    const { accept, entries } = fixture({ balance: 2n * cost - 1n });
    await accept(await ALICE.signTransaction(STANDARD));
    await expect(
      accept(await ALICE.signTransaction({ ...STANDARD, nonce: 1 })),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(entries).toHaveLength(1);
  });
});
