import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { ledgerForwarderAbi, ledgerTokenAbi } from "@ledgera/abis";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { signForwardRequest } from "@ledgera/shared/forward-request";
import {
  createPublicClient,
  encodeFunctionData,
  type Hex,
  http,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { AuditStore } from "../src/db/store.ts";

const config = {
  l2: process.env.TEST_AUDITOR_E2E_L2_RPC,
  deployment: process.env.TEST_AUDITOR_E2E_DEPLOYMENT,
  roles: process.env.TEST_AUDITOR_E2E_ROLES,
  database: process.env.TEST_AUDITOR_E2E_DATABASE_URL,
};

async function until<T>(
  read: () => Promise<T | undefined | false>,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined && result !== false) return result;
    await setTimeout(150);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(
      `${new URL(url).pathname} returned ${response.status}: ${await response.text()}`,
    );
  return response.json() as Promise<T>;
}

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const result = await get<{ result?: T; error?: unknown }>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (result.result === undefined)
    throw new Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.result;
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type Finding = {
  id: string;
  type: string;
  txHash?: Hex;
  block: string;
  evidence: {
    earlier?: { receipt: { txHash: Hex }; position: { blockHash: Hex } };
    later?: { receipt: { txHash: Hex }; position: { blockHash: Hex } };
    position?: { blockHash: Hex };
  };
};
type LogRow = {
  seq: string;
  txHash: Hex;
  forwardStatus: string;
  includedBlock: string | null;
};
type Accepted = { txHash: Hex; receipt: { seq: string } };

test.skipIf(!Object.values(config).every(Boolean))(
  "audits FIFO, a relay reorder, an interrupted forward and an orphaned direct transaction on Anvil",
  { timeout: 120_000 },
  async () => {
    const {
      l2,
      deployment: deploymentPath,
      roles: rolesFile,
      database,
    } = config;
    if (!l2 || !deploymentPath || !rolesFile || !database)
      throw new Error("Disposable Auditor E2E fixtures are required");
    const url = new URL(l2);
    expect(url.hostname).toBe("127.0.0.1");
    const chain = createPublicClient({ transport: http(l2), cacheTime: 0 });
    expect(await chain.getChainId()).toBe(31337);
    const deployment = await readDeployment(deploymentPath);
    expect(deployment.environment).toBe("anvil");
    const roles = parseEnv(await readFile(rolesFile, "utf8"));
    const roleValue = (name: string) => {
      const value = roles[name];
      if (!value) throw new Error(`Missing fixture role value ${name}`);
      return value;
    };
    const sender = (role: string) =>
      privateKeyToAccount(roleValue(`${role}_PRIVATE_KEY`) as Hex);
    const senders = [
      "VASP_A_ADMIN",
      "VASP_B_ADMIN",
      "ISSUER",
      "CONSORTIUM_1",
      "CONSORTIUM_2",
    ].map(sender);
    const initial = await chain.getBlockNumber();
    for (
      let blockNumber = BigInt(deployment.auditStartBlock);
      blockNumber <= initial;
      blockNumber++
    ) {
      const block = await chain.getBlock({ blockNumber });
      expect(
        block.transactions,
        `Use a fresh Anvil; block ${blockNumber} already has transactions`,
      ).toHaveLength(0);
    }
    const migrations = fileURLToPath(
      new URL("../src/db/migrations/", import.meta.url),
    );
    const auditDb = await openDatabase(database, "auditor", migrations);
    try {
      const audit = await new AuditStore(auditDb.db).inputs();
      expect(
        audit.state,
        "Use a fresh PostgreSQL database for the Auditor E2E",
      ).toBeUndefined();
      expect(audit.receipts).toEqual([]);
      expect(audit.blocks).toEqual([]);
    } finally {
      await auditDb.close();
    }
    let blockWrites = false;
    let blocked = 0;
    const proxy = createServer(async (request, response) => {
      try {
        const buffers: Buffer[] = [];
        for await (const fragment of request) buffers.push(fragment);
        const body = Buffer.concat(buffers).toString("utf8");
        const requestData = JSON.parse(body);
        if (blockWrites && requestData.method === "eth_sendRawTransaction") {
          blocked++;
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: requestData.id,
              error: { code: -32005, message: "Fixture write unavailable" },
            }),
          );
          return;
        }
        const backend = await fetch(l2, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        response.writeHead(backend.status, {
          "Content-Type": "application/json",
        });
        response.end(await backend.text());
      } catch {
        response.writeHead(503).end();
      }
    });
    const proxyPort = await listen(proxy);
    const children: ChildProcess[] = [];
    const shutdown = async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    };
    try {
      const [gatewayPort, auditPort] = await Promise.all([
        freePort(),
        freePort(),
      ]);
      const gateway = `http://127.0.0.1:${gatewayPort}`;
      const auditor = `http://127.0.0.1:${auditPort}`;
      function start(service: string, env: Record<string, string>) {
        const child = spawn(
          process.execPath,
          [`services/${service}/src/index.ts`],
          {
            env: {
              ...roles,
              ...env,
              DATABASE_URL: database,
              DEPLOYMENTS_FILE: deploymentPath,
            },
            stdio: ["ignore", "ignore", "inherit"],
          },
        );
        children.push(child);
      }
      start("gateway", {
        PORT: String(gatewayPort),
        SEQUENCER_RPC_URLS: `http://127.0.0.1:${proxyPort}`,
        COMMIT_INTERVAL_SEC: "3600",
        DEMO_MODE: "true",
        ADMIN_TOKEN: roleValue("GATEWAY_ADMIN_TOKEN"),
        RELAYER_KEYS: JSON.stringify({
          1: roles.RELAYER_A_PRIVATE_KEY,
          2: roles.RELAYER_B_PRIVATE_KEY,
        }),
        VASP_API_KEYS: JSON.stringify({
          1: roleValue("VASP_A_GATEWAY_API_KEY"),
          2: roleValue("VASP_B_GATEWAY_API_KEY"),
        }),
      });
      start("auditor", {
        PORT: String(auditPort),
        AUDIT_RPC_URL: l2,
        GATEWAY_URL: gateway,
        AUDIT_INTERVAL_SEC: "1",
        INCLUSION_DEADLINE_SEC: "120",
      });
      for (const service of [gateway, auditor]) {
        await until(
          () => get(`${service}/healthz`).catch(() => false),
          "service startup",
        );
      }
      const head = () => get<{ seq: string }>(`${gateway}/v1/log/head`);
      const log = async (from = "1") =>
        (
          await get<{ entries: LogRow[] }>(
            `${gateway}/v1/log?fromSeq=${from}&limit=1000`,
          )
        ).entries;
      const findings = async (from = "1") =>
        (
          await get<{ violations: Finding[] }>(
            `${auditor}/v1/fifo/violations?fromSeq=${from}`,
          )
        ).violations;
      expect((await head()).seq).toBe("0");
      const nonceOf = (account: LocalAccount) =>
        chain.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        });
      const sign = (account: LocalAccount, nonce: number) =>
        account.signTransaction({
          type: "eip1559",
          chainId: 31337,
          nonce,
          to: senders[1].address,
          value: 1n,
          gas: 21_000n,
          maxPriorityFeePerGas: 1n,
          maxFeePerGas: 100_000_000_000n,
        });
      const submit = (raw: Hex) =>
        rpc<Accepted>(`${gateway}/rpc`, "ledgera_sendRawTransaction", [raw]);
      await Promise.all(
        senders.map(async (account) => {
          const nonce = await nonceOf(account);
          for (let i = 0; i < 20; i++)
            await submit(await sign(account, nonce + i));
        }),
      );
      await rpc<string>(l2, "evm_mine");
      const last = await until(async () => {
        const entries = await log();
        return entries.length === 100 &&
          entries.every((entry) => entry.includedBlock)
          ? entries.at(-1)
          : undefined;
      }, "all user transactions included");
      expect(last.seq).toBe("100");
      const summary = () =>
        get<{ lastBlock: string; lastSeq: string; violations: number }>(
          `${auditor}/v1/fifo/summary`,
        );
      const normal = await until(async () => {
        const report = await summary();
        return report.lastSeq === "100" &&
          BigInt(report.lastBlock) >= BigInt(last.includedBlock ?? "0")
          ? report
          : undefined;
      }, "all receipts audited");
      expect(normal.violations).toBe(0);

      const cutoff = (BigInt((await head()).seq) + 1n).toString();
      await get(`${gateway}/admin/demo/reorder-next`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${roleValue("GATEWAY_ADMIN_TOKEN")}`,
        },
      });
      async function approve(
        from: LocalAccount,
        apiKey: string,
        amount: bigint,
      ) {
        const forwarder = deployment.contracts.ledgerForwarder;
        const data = encodeFunctionData({
          abi: ledgerTokenAbi,
          functionName: "approve",
          args: [deployment.contracts.atomicSwap, amount],
        });
        const nonce = await chain.readContract({
          abi: ledgerForwarderAbi,
          address: forwarder,
          functionName: "nonces",
          args: [from.address],
        });
        const operation = {
          from: from.address,
          to: deployment.contracts.tUSD,
          value: 0n,
          gas: 100_000n,
          deadline: Math.floor(Date.now() / 1000) + 300,
          nonce,
          data,
        };
        const signature = await signForwardRequest(
          from,
          { chainId: 31337, verifyingContract: forwarder },
          operation,
        );
        return get<Accepted>(`${gateway}/relay/v1/forward`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requests: [
              {
                ...operation,
                nonce: undefined,
                gas: "100000",
                value: "0",
                signature,
              },
            ],
          }),
        });
      }
      const held = approve(
        sender("VASP_A_ADMIN"),
        roleValue("VASP_A_GATEWAY_API_KEY"),
        11n,
      );
      held.catch(() => {});
      await until(
        async () =>
          (await log(cutoff)).find(
            (entry) => entry.forwardStatus === "held_demo",
          ),
        "held relay",
      );
      const second = await approve(
        sender("VASP_B_TREASURY"),
        roleValue("VASP_B_GATEWAY_API_KEY"),
        12n,
      );
      const first = await held;
      await rpc<string>(l2, "evm_mine");
      const reverse = await until(
        async () =>
          (await findings(cutoff)).find(
            (item) => item.type === "ORDER_VIOLATION",
          ),
        "one reorder",
      );
      expect(await findings(cutoff)).toHaveLength(1);
      expect(reverse.evidence.earlier?.receipt.txHash).toBe(first.txHash);
      expect(reverse.evidence.later?.receipt.txHash).toBe(second.txHash);
      expect(reverse.evidence.earlier?.position.blockHash).toBeTruthy();

      blockWrites = true;
      const heldFrom = (BigInt((await head()).seq) + 1n).toString();
      const delayed = submit(await sign(senders[0], await nonceOf(senders[0])));
      delayed.catch(() => {});
      const receipt = await until(
        async () => (await log(heldFrom))[0],
        "queued receipt",
      );
      expect(receipt.forwardStatus).toBe("queued");
      const lateFinding = () =>
        findings(heldFrom).then((rows) =>
          rows.find(
            (item) =>
              item.type === "NOT_INCLUDED" && item.txHash === receipt.txHash,
          ),
        );
      await until(async () => blocked > 0, "transfer attempt blocked");
      await rpc<number>(l2, "evm_increaseTime", [121]);
      await rpc<string>(l2, "evm_mine");
      const onDeadline = await until(lateFinding, "C5 at the L2 deadline");
      expect(blocked).toBeGreaterThan(0);
      expect(onDeadline.evidence.position).toBeUndefined();
      blockWrites = false;
      expect((await delayed).txHash).toBe(receipt.txHash);
      await rpc<string>(l2, "evm_mine");
      const late = await until(async () => {
        const item = await lateFinding();
        return item?.evidence.position ? item : undefined;
      }, "late inclusion evidence");
      expect(late.id).toBe(onDeadline.id);
      expect(late.evidence.position?.blockHash).toBeTruthy();

      const snapshot = await rpc<string>(l2, "evm_snapshot");
      const direct = await rpc<Hex>(l2, "eth_sendRawTransaction", [
        await sign(senders[0], await nonceOf(senders[0])),
      ]);
      await rpc<string>(l2, "evm_mine");
      const orphan = await until(
        async () =>
          (await findings()).find(
            (item) => item.type === "UNRECEIPTED_TX" && item.txHash === direct,
          ),
        "C6 on direct transaction",
      );
      expect(await rpc<boolean>(l2, "evm_revert", [snapshot])).toBe(true);
      while ((await chain.getBlockNumber()) < BigInt(orphan.block)) {
        await rpc<string>(l2, "evm_mine");
      }
      await until(async () => {
        const result = await summary();
        if (BigInt(result.lastBlock) < BigInt(orphan.block)) return undefined;
        return (
          (await findings()).every((item) => item.txHash !== direct) ||
          undefined
        );
      }, "orphaned C6 removed");
    } finally {
      await Promise.all(children.map(shutdown));
      proxy.close();
    }
  },
);
