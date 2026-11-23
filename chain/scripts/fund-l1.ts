import { formatEther, parseEther } from "viem";
import { address, adminWallet, required, sepoliaClient } from "./l1.ts";

async function main() {
  const wallet = adminWallet();
  const client = await sepoliaClient();
  for (const [name, target] of [
    ["BATCHER_ADDRESS", parseEther("0.5")],
    ["ATTACKER_ADDRESS", parseEther("0.05")],
  ] as const) {
    const to = address(required(name));
    const balance = await client.getBalance({ address: to });
    const value = target - balance;
    if (value <= 0n) continue;

    const hash = await wallet.sendTransaction({ to, value });
    console.log(
      `Sepolia funding ${name} with ${formatEther(value)} ETH: ${hash}`,
    );
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new Error(`Funding ${name} reverted`);
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
