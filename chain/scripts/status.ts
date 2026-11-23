import { createPublicClient, formatEther, http } from "viem";
import { address, required, sepoliaClient } from "./l1.ts";

async function main() {
  const proxy = "http://127.0.0.1:8545";
  const l2 = createPublicClient({ transport: http(proxy) });
  const l1 = await sepoliaClient();
  const rollupResponse = await fetch(`${proxy}/rollup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "optimism_syncStatus",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const status = await rollupResponse.json();
  if (
    !rollupResponse.ok ||
    typeof status.result?.safe_l2?.number !== "number"
  ) {
    throw new Error("Could not read the safe L2 block from op-node");
  }

  const block = await l2.getBlock({ blockTag: "latest" });
  console.table({
    "L1 block": (await l1.getBlockNumber()).toString(),
    "L2 block": block.number.toString(),
    "L2 block time (UTC)": new Date(
      Number(block.timestamp) * 1000,
    ).toISOString(),
    "L2 safe block": status.result.safe_l2.number,
  });

  const roles = [
    "ADMIN",
    "BATCHER",
    "ATTACKER",
    "GATEWAY",
    "RELAYER_A",
    "RELAYER_B",
    "VASP_A_ADMIN",
    "VASP_B_ADMIN",
    "ISSUER",
    "CONSORTIUM_1",
    "CONSORTIUM_2",
    "CONSORTIUM_3",
  ];
  const rows = await Promise.all(
    roles.map(async (role) => {
      const account = address(required(`${role}_ADDRESS`));
      const l1Balance = ["ADMIN", "BATCHER", "ATTACKER"].includes(role)
        ? formatEther(await l1.getBalance({ address: account }))
        : "-";
      return {
        role,
        address: account,
        "Sepolia ETH": l1Balance,
        "L2 ETH": formatEther(await l2.getBalance({ address: account })),
      };
    }),
  );
  console.table(rows);
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("\n", 1)[0]
      : "Status check failed",
  );
  process.exitCode = 1;
}
