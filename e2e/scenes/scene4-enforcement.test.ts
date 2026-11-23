import {
  createPublicClient,
  type Hash,
  http,
  parseEther,
  TransactionReceiptNotFoundError,
} from "viem";
import { expect, test } from "vitest";
import { api, waitFor } from "./support.ts";

type Deposit = {
  l1TxHash: Hash;
  l1Status: string;
  l2TxHash: Hash | null;
  l2Status: string;
  l2BalanceWei: string;
  probeCountBefore: string;
  probeCountAfter: string;
};
const rpc = createPublicClient({
  transport: http(process.env.LEDGERA_E2E_RPC_URL ?? "http://127.0.0.1:8545", {
    retryCount: 0,
  }),
});
const base = "/v1/attacker";
const status = () =>
  api<{
    registryStatus: number;
    enforcementEnabled: boolean;
    l2BalanceWei: string;
    probeCount: string;
  }>("demo", `${base}/status`);

test.skipIf(
  process.env.LEDGERA_E2E !== "1" || process.env.APP_MODE === "anvil",
)(
  "場面 4 は未登録のデモアカウントの取引を拒否する",
  async () => {
    const before = await status();
    expect(before.registryStatus).toBe(0);
    expect(before.enforcementEnabled).toBe(true);
    const deposit = await api<Deposit>("demo", `${base}/l1-deposit`, {
      body: { mintEth: "0.001", action: "probe" },
    });
    const confirmed = await waitFor(
      async () => {
        const result = await api<Deposit>(
          "demo",
          `${base}/deposits/${deposit.l1TxHash}`,
        );
        expect(result.l1Status).not.toBe("failed");
        if (result.l2TxHash && result.l2Status !== "pending")
          return { ...result, l2TxHash: result.l2TxHash };
      },
      "The L1 deposit has not reached L2",
      150_000,
    );
    expect(confirmed.l2Status).toBe("failed");
    expect(confirmed.probeCountAfter).toBe(before.probeCount);
    expect(confirmed.probeCountBefore).toBe(before.probeCount);
    expect(BigInt(confirmed.l2BalanceWei)).toBe(
      BigInt(before.l2BalanceWei) + parseEther("0.001"),
    );
    expect(
      (await rpc.getTransactionReceipt({ hash: confirmed.l2TxHash })).status,
    ).toBe("reverted");
    for (const [route, action] of [
      ["direct", "token-transfer"],
      ["direct", "eth-transfer"],
      ["direct", "deploy"],
      ["gateway", "token-transfer"],
    ] as const) {
      const result = await api<{
        accepted: boolean;
        txHash: Hash;
        error?: { message: string };
      }>("demo", `${base}/l2-send`, { body: { route, action } });
      expect(result.accepted).toBe(false);
      expect(result.error?.message).toContain("ledgera: sender not allowed");
      await expect(
        rpc.getTransactionReceipt({ hash: result.txHash }),
      ).rejects.toBeInstanceOf(TransactionReceiptNotFoundError);
    }
  },
  240_000,
);
