import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import {
  type Address,
  createPublicClient,
  getAddress,
  http,
  type Log,
  parseAbi,
  parseAbiItem,
  zeroAddress,
} from "viem";

const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const PROXY_ADMIN = "0x4200000000000000000000000000000000000018";
const UNREGISTERED_DEV_ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const KYC_REJECTION = "ledgera: sender not allowed";
const LOG_WINDOW = 1000n;
const ENFORCEMENT_EVENT = parseAbiItem(
  "event EnforcementEnabled(uint64 version, address indexed actor)",
);
const CONSORTIUM_EVENT = parseAbiItem(
  "event ConsortiumTransferred(address indexed previous, address indexed current)",
);
const PROXY_ADMIN_EVENT = parseAbiItem(
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
);
const GAS_PRICE_ABI = parseAbi([
  "function baseFeeScalar() view returns (uint32)",
  "function blobBaseFeeScalar() view returns (uint32)",
]);

const contractNames = [
  "kycRegistry",
  "ledgerForwarder",
  "travelRuleCompliance",
  "tJPY",
  "tUSD",
  "atomicSwap",
  "receiptLog",
  "depositProbe",
  "consortiumSafe",
] as const;
type Mode = "anvil" | "devnet";
type Client = ReturnType<typeof createPublicClient>;

async function waitForFees(client: Client) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const fees = await Promise.all(
      (["baseFeeScalar", "blobBaseFeeScalar"] as const).map((functionName) =>
        client.readContract({
          address: GAS_PRICE_ORACLE,
          abi: GAS_PRICE_ABI,
          functionName,
        }),
      ),
    );
    if (fees.every((fee) => fee === 0)) return;
    await setTimeout(2000);
  }
  throw new Error("L2 GasPriceOracle fee scalars must both be zero");
}

async function existingManifest(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

async function findLog(
  head: bigint,
  read: (range: { fromBlock: bigint; toBlock: bigint }) => Promise<Log[]>,
  previous?: number,
) {
  if (previous !== undefined) {
    const block = BigInt(previous);
    const [log] = await read({ fromBlock: block, toBlock: block });
    if (log) return log;
  }
  for (let fromBlock = 0n; fromBlock <= head; fromBlock += LOG_WINDOW) {
    const end = fromBlock + LOG_WINDOW - 1n;
    const [log] = await read({ fromBlock, toBlock: end < head ? end : head });
    if (log) return log;
  }
}

async function findBootstrapBlocks(
  client: Client,
  mode: Mode,
  registry: Address,
  safe: Address,
  head: bigint,
  previous?: { enforcementBlock: number; auditStartBlock: number },
): Promise<{ enforcementBlock: number; auditStartBlock: number }> {
  const [enforcement, finalization] = await Promise.all([
    findLog(
      head,
      (range) =>
        client.getLogs({
          address: registry,
          event: ENFORCEMENT_EVENT,
          ...range,
        }),
      previous?.enforcementBlock,
    ),
    findLog(
      head,
      (range) =>
        mode === "anvil"
          ? client.getLogs<typeof CONSORTIUM_EVENT>({
              address: registry,
              event: CONSORTIUM_EVENT,
              args: { current: safe },
              ...range,
            })
          : client.getLogs<typeof PROXY_ADMIN_EVENT>({
              address: PROXY_ADMIN,
              event: PROXY_ADMIN_EVENT,
              args: { newOwner: safe },
              ...range,
            }),
      previous ? previous.auditStartBlock - 1 : undefined,
    ),
  ]);
  if (
    enforcement?.blockNumber == null ||
    enforcement.transactionHash == null ||
    finalization?.blockNumber == null ||
    finalization.blockNumber < enforcement.blockNumber
  )
    throw new Error("Bootstrap transactions were not confirmed");
  if (mode === "devnet") {
    const receipt = await client.request({
      method: "eth_getTransactionReceipt",
      params: [enforcement.transactionHash],
    });
    const l1Fee = receipt && "l1Fee" in receipt ? receipt.l1Fee : undefined;
    if (typeof l1Fee !== "string" || BigInt(l1Fee) !== 0n) {
      throw new Error("The enforcement transaction must have zero L1 data fee");
    }
  }
  return {
    enforcementBlock: Number(enforcement.blockNumber),
    auditStartBlock: Number(finalization.blockNumber) + 1,
  };
}

async function requireSenderRejection(client: Client) {
  try {
    await client.estimateGas({
      account: UNREGISTERED_DEV_ACCOUNT,
      to: UNREGISTERED_DEV_ACCOUNT,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes(KYC_REJECTION)) return;
    throw new Error("Unable to confirm KYC rejection in the execution layer", {
      cause: error,
    });
  }
  throw new Error("The execution layer accepted an unregistered sender");
}

async function writeManifest(
  client: Client,
  mode: Mode,
  chainId: number,
  source: string,
) {
  const raw: Record<string, string> = JSON.parse(
    await readFile(source, "utf8"),
  );
  const contracts = Object.fromEntries(
    contractNames.map((name) => [name, getAddress(raw[name])]),
  ) as Record<(typeof contractNames)[number], Address>;
  const deployedCode = await Promise.all(
    contractNames.map((name) => client.getCode({ address: contracts[name] })),
  );
  if (deployedCode.some((code) => !code || code === "0x"))
    throw new Error("Some bootstrap contracts have no code");

  const path = `deployments/${mode}.json`;
  const existing = await existingManifest(path);
  if (mode === "devnet" && (existing?.chainId !== chainId || !existing.l1)) {
    throw new Error("Run make chain-deploy to prepare the devnet manifest");
  }
  const sameDeployment =
    existing?.chainId === chainId &&
    contractNames.every(
      (name) =>
        existing?.contracts?.[name]?.toLowerCase() ===
        contracts[name].toLowerCase(),
    );
  const head = await client.getBlockNumber();
  const previous =
    sameDeployment &&
    Number.isSafeInteger(existing.enforcementBlock) &&
    existing.enforcementBlock >= 0 &&
    Number.isSafeInteger(existing.auditStartBlock) &&
    existing.auditStartBlock > existing.enforcementBlock &&
    BigInt(existing.auditStartBlock - 1) <= head
      ? existing
      : undefined;
  const blocks = await findBootstrapBlocks(
    client,
    mode,
    contracts.kycRegistry,
    contracts.consortiumSafe,
    head,
    previous,
  );
  if (mode === "devnet") await requireSenderRejection(client);
  const result = {
    environment: mode,
    chainId,
    ...blocks,
    ...(mode === "devnet" ? { l1: existing.l1 } : {}),
    contracts,
    vasps: { network: 0, a: 1, b: 2 },
  };

  await mkdir("deployments", { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporary, 0o644);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`Wrote ${path}`);
}

async function main() {
  const [action, mode, url, chainIdValue, source] = process.argv.slice(2);
  if ((mode !== "anvil" && mode !== "devnet") || !url)
    throw new Error("Invalid bootstrap mode or RPC URL");
  const chainId = Number(chainIdValue);
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    throw new Error("Set L2_CHAIN_ID");
  const client = createPublicClient({ transport: http(url) });
  if ((await client.getChainId()) !== chainId)
    throw new Error("The bootstrap RPC belongs to a different chain");

  if (action === "preflight") {
    const existing = await existingManifest(`deployments/${mode}.json`);
    if (mode === "devnet") {
      if (existing?.chainId !== chainId || !existing.l1)
        throw new Error("Run make chain-deploy first");
      await waitForFees(client);
    }
    console.log(getAddress(existing?.contracts?.kycRegistry ?? zeroAddress));
  } else if (action === "write" && source) {
    await writeManifest(client, mode, chainId, source);
  } else {
    throw new Error("Unknown bootstrap manifest action");
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("\n", 1)[0]
      : "Bootstrap failed",
  );
  process.exitCode = 1;
}
