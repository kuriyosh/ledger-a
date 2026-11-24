import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createPublicClient, type Hash, http, isHex, keccak256 } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { api } from "./scenes/support.ts";

const roles = [
  "ISSUER",
  "CONSORTIUM_1",
  "CONSORTIUM_2",
  "CONSORTIUM_3",
  "RELAYER_A",
] as const;
const transactionsPerSender = 20;
const gateway = process.env.LEDGERA_E2E_GATEWAY_URL ?? "http://127.0.0.1:8600";
const sequencer = createPublicClient({
  transport: http(process.env.LEDGERA_E2E_RPC_URL ?? "http://127.0.0.1:8545"),
  pollingInterval: 500,
});

type Admission = { receipt: { seq: string; txHash: Hash }; txHash: Hash };

function sign(
  account: PrivateKeyAccount,
  chainId: number,
  nonce: number,
  maxPriorityFeePerGas: bigint,
) {
  return account.signTransaction({
    chainId,
    nonce,
    type: "eip1559",
    to: account.address,
    value: 0n,
    gas: 21_000n,
    maxFeePerGas: 100_000_000_000n,
    maxPriorityFeePerGas,
  });
}

async function submit(raw: Hash, nonce: number, signal: AbortSignal) {
  const response = await fetch(new URL("/rpc", gateway), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nonce,
      method: "ledgera_sendRawTransaction",
      params: [raw],
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  const payload: {
    result?: Admission;
    error?: { message: string; data?: { reason?: string } };
  } = await response.json();
  if (!response.ok) throw new Error(`Gateway HTTP status: ${response.status}`);
  return payload;
}

async function admit(raw: Hash, nonce: number, signal: AbortSignal) {
  const payload = await submit(raw, nonce, signal);
  if (!payload.result) {
    throw new Error(
      `Gateway admission failed: ${payload.error?.data?.reason ?? payload.error?.message ?? "missing Receipt"}`,
    );
  }
  const hash = keccak256(raw);
  expect(payload.result.txHash).toBe(hash);
  expect(payload.result.receipt.txHash).toBe(hash);
  return { seq: BigInt(payload.result.receipt.seq), txHash: hash };
}

test.skipIf(process.env.LEDGERA_FIFO_E2E !== "1")(
  "同じ優先手数料で 5 送信者から送った 100 件が Receipt の通番順で取り込まれる",
  async () => {
    const defaultAccounts =
      process.env.APP_MODE === "anvil"
        ? "chain/runtime/anvil/.env.generated"
        : ".env.generated";
    const accounts = parseEnv(
      await readFile(
        process.env.LEDGERA_E2E_ACCOUNTS ?? defaultAccounts,
        "utf8",
      ),
    );
    const signers = roles.map((role) => {
      const key = accounts[`${role}_PRIVATE_KEY`];
      if (!key || !isHex(key) || key.length !== 66) {
        throw new Error(`Bootstrap account for ${role} is missing`);
      }
      return privateKeyToAccount(key);
    });
    expect(new Set(signers.map((signer) => signer.address)).size).toBe(
      roles.length,
    );
    const status = await api<{ queueLength: number }>("gateway", "/v1/status");
    expect(status.queueLength).toBe(0);
    const chainId = await sequencer.getChainId();
    const firstNonces = await Promise.all(
      signers.map(async ({ address }) => {
        const [latest, pending] = await Promise.all([
          sequencer.getTransactionCount({ address, blockTag: "latest" }),
          sequencer.getTransactionCount({ address, blockTag: "pending" }),
        ]);
        expect(pending, `Pending transactions for ${address}`).toBe(latest);
        return pending;
      }),
    );
    const stop = new AbortController();
    const wrongFee = await sign(signers[0], chainId, firstNonces[0], 2n);
    const rejected = await submit(wrongFee, firstNonces[0], stop.signal);
    expect(rejected.result).toBeUndefined();
    expect(rejected.error?.data?.reason).toBe("PRIORITY_FEE_NOT_FIXED");

    const startBlock = (await sequencer.getBlockNumber({ cacheTime: 0 })) + 1n;
    const groups = await Promise.all(
      signers.map(async (account, senderIndex) => {
        const admissions: Awaited<ReturnType<typeof admit>>[] = [];
        try {
          for (let index = 0; index < transactionsPerSender; index++) {
            stop.signal.throwIfAborted();
            const nonce = firstNonces[senderIndex] + index;
            const raw = await sign(account, chainId, nonce, 1n);
            admissions.push(await admit(raw, nonce, stop.signal));
          }
          return admissions;
        } catch (error) {
          stop.abort(error);
          return [];
        }
      }),
    );
    stop.signal.throwIfAborted();
    const entries = groups
      .flat()
      .sort((left, right) => Number(left.seq - right.seq));
    expect(entries).toHaveLength(roles.length * transactionsPerSender);
    const firstSeq = entries[0].seq;
    const lastSeq = entries[entries.length - 1].seq;
    const ledger = await api<{
      entries: { seq: string; txHash: Hash; source: string }[];
    }>("gateway", `/v1/log?fromSeq=${firstSeq}&limit=1000`);
    const submitted = ledger.entries
      .filter(
        ({ seq, source }) => BigInt(seq) <= lastSeq && source !== "system",
      )
      .map(({ seq, txHash }) => ({ seq: BigInt(seq), txHash }));
    expect(submitted).toEqual(entries);
    await Promise.all(
      groups.map((group) =>
        sequencer.waitForTransactionReceipt({
          hash: group[group.length - 1].txHash,
          timeout: 45_000,
        }),
      ),
    );
    const receipts = await Promise.all(
      entries.map(({ txHash }) =>
        sequencer.getTransactionReceipt({ hash: txHash }),
      ),
    );
    for (const receipt of receipts) {
      expect(receipt.status, `L2 transaction ${receipt.transactionHash}`).toBe(
        "success",
      );
    }
    for (const [index, current] of receipts.slice(1).entries()) {
      const previous = receipts[index];
      const later =
        current.blockNumber > previous.blockNumber ||
        (current.blockNumber === previous.blockNumber &&
          current.transactionIndex > previous.transactionIndex);
      expect(
        later,
        `Receipt order inverted at seq ${entries[index + 1].seq}`,
      ).toBe(true);
    }
    const sharedBlock = receipts.slice(1).some((current, index) => {
      const previous = receipts[index];
      return (
        current.blockNumber === previous.blockNumber &&
        current.from !== previous.from
      );
    });
    expect(
      sharedBlock,
      "No block contains test transactions from multiple senders",
    ).toBe(true);

    await api("auditor", "/v1/fifo/run", { method: "POST" });
    const filters = new URLSearchParams({
      fromSeq: firstSeq.toString(),
      fromBlock: startBlock.toString(),
    });
    const summary = await api<{
      lastSeq: string;
      lastBlock: string | null;
      violations: number;
      exclusions: number;
    }>("auditor", `/v1/fifo/summary?${filters}`);
    const lastBlock = receipts[receipts.length - 1].blockNumber;
    expect(BigInt(summary.lastSeq)).toBeGreaterThanOrEqual(lastSeq);
    if (summary.lastBlock === null)
      throw new Error("The auditor has no processed blocks");
    expect(BigInt(summary.lastBlock)).toBeGreaterThanOrEqual(lastBlock);
    expect(summary.violations).toBe(0);
    expect(summary.exclusions).toBe(0);
  },
  120_000,
);
