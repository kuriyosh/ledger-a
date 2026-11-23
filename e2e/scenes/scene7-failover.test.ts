import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { type Address, createPublicClient, type Hash, http } from "viem";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const origin = process.env.LEDGERA_WEB_URL ?? "http://127.0.0.1:3000";
const chain = createPublicClient({
  transport: http(process.env.LEDGERA_E2E_RPC_URL ?? "http://127.0.0.1:8545", {
    retryCount: 0,
  }),
});
type Customer = {
  id: string;
  address: Address | null;
  email: string;
  kycStatus: string;
};
type Gateway = {
  leader: string | null;
  lastSeq: string;
  sequencers: { id: string; leader: boolean; healthy: boolean }[];
};
type Audit = { checks: { C4: number; C5: number } };
async function request<T>(
  service: string,
  path: string,
  method = "GET",
  body?: object,
  token?: string,
): Promise<T> {
  const response = await fetch(new URL(`/api/${service}${path}`, origin), {
    method,
    headers: {
      Accept: "application/json",
      ...(body && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      `${service + path} returned ${response.status}: ${value.error?.code ?? "unexpected response"}`,
    );
  return value as T;
}
async function until<T>(
  query: () => Promise<T | undefined>,
  limit = 30_000,
): Promise<T> {
  const end = performance.now() + limit;
  while (performance.now() <= end) {
    const value = await query();
    if (value !== undefined) return value;
    await setTimeout(150);
  }
  throw new Error("Timed out waiting for HA state");
}
async function customer(email: string, givenName: string) {
  const result = await request<Customer>("vasp-a", "/v1/customers", "POST", {
    email,
    familyName: "冗長試験",
    givenName,
    country: "JP",
    dateOfBirth: "1990-01-01",
    addressLine: "東京都",
  });
  await request(
    "vasp-a",
    `/v1/admin/customers/${result.id}/kyc/approve`,
    "POST",
  );
  return until(async () => {
    const list = await request<{ customers: Customer[] }>(
      "vasp-a",
      "/v1/admin/customers",
    );
    const row = list.customers.find((item) => item.id === result.id);
    if (row?.address && row.kycStatus === "approved")
      return { ...row, address: row.address };
  });
}
const status = () => request<Gateway>("gateway", "/v1/status");
const audit = () => request<Audit>("auditor", "/v1/fifo/run", "POST");
const control = (target: string) => {
  const options = [];
  if (process.env.LEDGERA_E2E_HA_COMPOSE)
    options.push(`HA_COMPOSE=${process.env.LEDGERA_E2E_HA_COMPOSE}`);
  if (process.env.LEDGERA_E2E_CHAIN_COMPOSE)
    options.push(`CHAIN_COMPOSE=${process.env.LEDGERA_E2E_CHAIN_COMPOSE}`);
  return exec("make", [target, ...options], {
    cwd: process.env.LEDGERA_E2E_HA_DIRECTORY,
    timeout: 85_000,
  });
};

test.skipIf(
  process.env.LEDGERA_E2E !== "1" || process.env.APP_MODE !== "devnet-ha",
)(
  "場面 7 はリーダー停止中にも取引を保持し、別の組で取り込む",
  async () => {
    const suffix = `${randomUUID().replaceAll("-", "")}@example.invalid`;
    const sender = await customer(`ha-sender-${suffix}`, "送信");
    const recipient = await customer(`ha-recipient-${suffix}`, "受信");
    const { token } = await request<{ token: string }>(
      "vasp-a",
      "/v1/session",
      "POST",
      { email: sender.email },
    );
    await request("demo", "/v1/issuer/mint", "POST", {
      token: "tJPY",
      to: sender.address,
      amount: "100000000",
    });
    const before = await audit();
    const previous = await status();
    expect(previous.leader).toBeTruthy();
    expect(previous.sequencers).toHaveLength(3);
    const height = await chain.getBlockNumber({ cacheTime: 0 });
    const started = performance.now();
    const stopped = control("ha-kill-leader").then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await setTimeout(500);
      const submission = request<{ id: string }>(
        "vasp-a",
        "/v1/me/transfers",
        "POST",
        {
          toAddress: recipient.address,
          token: "tJPY",
          amount: "1000000",
        },
        token,
      );
      const [operation, leader] = await Promise.all([
        submission,
        until(async () => {
          const view = await status();
          const head = await chain
            .getBlockNumber({ cacheTime: 0 })
            .catch(() => height);
          if (view.leader && view.leader !== previous.leader && head > height) {
            expect(performance.now() - started).toBeLessThan(30_000);
            return view.leader;
          }
        }),
      ]);
      const stopError = await stopped;
      if (stopError) throw stopError;
      const transfer = await until(async () => {
        const value = await request<{
          status: string;
          txHash: Hash | null;
          gatewaySeq: string | null;
        }>(
          "vasp-a",
          `/v1/me/transfers/${operation.id}`,
          "GET",
          undefined,
          token,
        );
        expect(value.status).not.toBe("failed");
        if (value.status === "confirmed" && value.txHash && value.gatewaySeq)
          return { hash: value.txHash, seq: BigInt(value.gatewaySeq) };
      }, 40_000);
      expect(transfer.seq).toBeGreaterThan(BigInt(previous.lastSeq));
      const receipt = await chain.getTransactionReceipt({
        hash: transfer.hash,
      });
      expect(receipt.status).toBe("success");
      const blocks = await Promise.all(
        Array.from(
          { length: Number(receipt.blockNumber - height + 2n) },
          (_, index) =>
            chain.getBlock({ blockNumber: height - 1n + BigInt(index) }),
        ),
      );
      for (let index = 1; index < blocks.length; index++)
        expect(blocks[index].parentHash).toBe(blocks[index - 1].hash);
      expect((await audit()).checks).toMatchObject({
        C4: before.checks.C4,
        C5: before.checks.C5,
      });
      await control("ha-restore");
      const restored = await status();
      expect(
        restored.sequencers
          .filter((item) => item.leader)
          .map((item) => item.id),
      ).toEqual([leader]);
    } finally {
      await stopped.catch(() => {});
      if (
        (await status().catch(() => undefined))?.sequencers.some(
          (node) => !node.healthy,
        )
      ) {
        await control("ha-restore").catch(() => {});
      }
    }
  },
  180_000,
);
