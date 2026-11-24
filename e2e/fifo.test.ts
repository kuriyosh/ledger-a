import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createPublicClient, type Hash, http, isHex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

async function admit(raw: Hash, nonce: number): Promise<Admission> {
  const response = await fetch(new URL("/rpc", gateway), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nonce,
      method: "ledgera_sendRawTransaction",
      params: [raw],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload: {
    result?: Admission;
    error?: { message: string; data?: { reason?: string } };
  } = await response.json();
  if (!response.ok || !payload.result) {
    throw new Error(
      `Gateway admission failed: ${payload.error?.data?.reason ?? payload.error?.message ?? response.status}`,
    );
  }
  const hash = keccak256(raw);
  expect(payload.result.txHash).toBe(hash);
  expect(payload.result.receipt.txHash).toBe(hash);
  return payload.result;
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
    const chainId = await sequencer.getChainId();
    const startBlock = (await sequencer.getBlockNumber({ cacheTime: 0 })) + 1n;
    const groups = await Promise.all(
      signers.map(async (account) => {
        const admissions: Admission[] = [];
        const firstNonce = await sequencer.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        });
        for (let index = 0; index < transactionsPerSender; index++) {
          const nonce = firstNonce + index;
          const raw = await account.signTransaction({
            chainId,
            nonce,
            type: "eip1559",
            to: account.address,
            value: 0n,
            gas: 21_000n,
            maxFeePerGas: 100_000_000_000n,
            maxPriorityFeePerGas: 1n,
          });
          admissions.push(await admit(raw, nonce));
        }
        await sequencer.waitForTransactionReceipt({
          hash: admissions[admissions.length - 1].txHash,
          timeout: 45_000,
        });
        return admissions;
      }),
    );
    const entries = groups
      .flat()
      .map(({ receipt, txHash }) => ({ seq: BigInt(receipt.seq), txHash }))
      .sort((left, right) => Number(left.seq - right.seq));
    const firstSeq = entries[0].seq;
    expect(entries).toHaveLength(roles.length * transactionsPerSender);
    expect(entries.map(({ seq }) => seq)).toEqual(
      entries.map((_, index) => firstSeq + BigInt(index)),
    );
    const receipts = await Promise.all(
      entries.map(({ txHash }) =>
        sequencer.getTransactionReceipt({ hash: txHash }),
      ),
    );
    expect(receipts.every((receipt) => receipt.status === "success")).toBe(
      true,
    );
    for (const [index, current] of receipts.entries()) {
      if (index === 0) continue;
      const previous = receipts[index - 1];
      const later =
        current.blockNumber > previous.blockNumber ||
        (current.blockNumber === previous.blockNumber &&
          current.transactionIndex > previous.transactionIndex);
      expect(later, `Receipt order inverted at seq ${entries[index].seq}`).toBe(
        true,
      );
    }

    await api("auditor", "/v1/fifo/run", { method: "POST" });
    const filters = new URLSearchParams({
      fromSeq: firstSeq.toString(),
      fromBlock: startBlock.toString(),
    });
    const summary = await api<{
      lastSeq: string;
      lastBlock: string;
      violations: number;
      exclusions: number;
    }>("auditor", `/v1/fifo/summary?${filters}`);
    const lastSeq = entries[entries.length - 1].seq;
    const lastBlock = receipts[receipts.length - 1].blockNumber;
    expect(BigInt(summary.lastSeq)).toBeGreaterThanOrEqual(lastSeq);
    expect(BigInt(summary.lastBlock)).toBeGreaterThanOrEqual(lastBlock);
    expect(summary.violations).toBe(0);
    expect(summary.exclusions).toBe(0);
  },
  120_000,
);
