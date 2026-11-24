import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { createPublicClient, http, parseEther } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { createApp } from "../src/routes/rpc.ts";

const exec = promisify(execFile);
const anvilMnemonic =
  "test test test test test test test test test test test junk";

test("shows Anvil state and prevents a valid signed transaction from being included", async () => {
  const image = process.env.FOUNDRY_IMAGE;
  if (!image) throw new Error("Use mise run test-integration");
  const { stdout } = await exec("docker", [
    "run",
    "--rm",
    "-d",
    "-p",
    "127.0.0.1::8545",
    "--entrypoint",
    "anvil",
    image,
    "--host",
    "0.0.0.0",
  ]);
  const container = stdout.trim();
  try {
    const { stdout: endpoint } = await exec("docker", [
      "port",
      container,
      "8545/tcp",
    ]);
    const l2 = `http://${endpoint.trim()}`;
    const client = createPublicClient({
      transport: http(l2, { retryCount: 0 }),
    });
    for (let attempts = 0; ; attempts++) {
      try {
        await client.getChainId();
        break;
      } catch (error) {
        if (attempts === 39) throw error;
        await setTimeout(250);
      }
    }

    const app = createApp({ l2 });
    const read = await app.request("/", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
    });
    expect(await read.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: "0x7a69",
    });

    const before = await client.getBlockNumber({ cacheTime: 0 });
    const sender = mnemonicToAccount(anvilMnemonic);
    const receiver = mnemonicToAccount(anvilMnemonic, { addressIndex: 1 });
    const signed = await sender.signTransaction({
      chainId: 31337,
      nonce: 0,
      to: receiver.address,
      value: parseEther("1"),
      gas: 21_000n,
      gasPrice: 2_000_000_000n,
      type: "legacy",
    });
    const write = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_sendRawTransaction",
        params: [signed],
      }),
    });
    expect(await write.json()).toMatchObject({
      id: 2,
      error: { code: -32601 },
    });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(before);
    expect(await client.getTransactionCount({ address: sender.address })).toBe(
      0,
    );

    const hash = await client.sendRawTransaction({
      serializedTransaction: signed,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
  } finally {
    await exec("docker", ["rm", "-f", container]);
  }
}, 60_000);
