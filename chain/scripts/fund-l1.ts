import { mkdir, rmdir } from "node:fs/promises";
import { formatEther, parseEther } from "viem";
import {
  address,
  adminWallet,
  required,
  requirePlainAccount,
  sepoliaClient,
} from "./l1.ts";

const lock = "chain/.deployer/l1-operation.lock";

async function fund() {
  const wallet = adminWallet();
  const client = await sepoliaClient();
  const targets = [
    {
      name: "Batcher",
      to: address(required("BATCHER_ADDRESS")),
      target: parseEther("0.5"),
    },
    {
      name: "Attacker",
      to: address(required("ATTACKER_ADDRESS")),
      target: parseEther("0.05"),
    },
  ];

  await Promise.all([
    requirePlainAccount(client, wallet.account.address, "Admin"),
    ...targets.map(({ name, to }) => requirePlainAccount(client, to, name)),
  ]);
  for (const { name, to, target } of targets) {
    const balance = await client.getBalance({
      address: to,
      blockTag: "pending",
    });
    const value = target - balance;
    if (value <= 0n) continue;

    const hash = await wallet.sendTransaction({ to, value });
    console.log(
      `Sepolia funding ${name} with ${formatEther(value)} ETH: ${hash}`,
    );
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new Error(`Funding ${name} reverted`);
    if (
      (await client.getBalance({
        address: to,
        blockNumber: receipt.blockNumber,
      })) < target
    ) {
      throw new Error(`Funding ${name} did not reach the target balance`);
    }
  }
}

async function main() {
  await mkdir("chain/.deployer", { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`An L1 operation is already locked at ${lock}`);
    }
    throw error;
  }
  try {
    await fund();
  } finally {
    await rmdir(lock);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message.split("\n", 1)[0] : "Funding failed",
  );
  process.exitCode = 1;
}
