import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { expect, test } from "vitest";
import {
  defineLedgerChain,
  deploymentSchema,
  environmentSchema,
  readDeployment,
} from "../src/index.ts";

const account = "0x9858effd232b4033e47d90003d41ec34ecaeda94";
const anvil = {
  environment: "anvil",
  chainId: 31337,
  enforcementBlock: 20,
  auditStartBlock: 22,
  contracts: {
    kycRegistry: account,
    ledgerForwarder: account,
    travelRuleCompliance: account,
    tJPY: account,
    tUSD: account,
    atomicSwap: account,
    receiptLog: account,
    depositProbe: account,
    consortiumSafe: account,
  },
  vasps: { network: 0, a: 1, b: 2 },
};

test("loads a bootstrap manifest and normalizes Ethereum addresses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledgera-deployment-"));
  try {
    const path = join(dir, "anvil.json");
    await writeFile(path, JSON.stringify(anvil));
    const deployment = await readDeployment(path);
    expect(deployment.environment).toBe("anvil");
    expect(deployment.contracts.kycRegistry).toBe(getAddress(account));
    expect(deployment.auditStartBlock).toBe(22);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validates deployment mode, audit boundary, and required contract and L1 fields", () => {
  const l1 = {
    chainId: 11155111,
    optimismPortal: account,
    systemConfig: account,
  };
  const devnet = { ...anvil, environment: "devnet", chainId: 202610, l1 };
  expect(deploymentSchema.safeParse(devnet).success).toBe(true);
  for (const invalid of [
    { environment: "devnet", chainId: 202610, l1 },
    { ...anvil, chainId: 202610 },
    { ...anvil, auditStartBlock: anvil.enforcementBlock },
    { ...anvil, l1 },
    { ...devnet, l1: { ...l1, chainId: 1 } },
    { ...devnet, contracts: { ...devnet.contracts, tJPY: "invalid" } },
  ]) {
    expect(deploymentSchema.safeParse(invalid).success).toBe(false);
  }
});

test("parses environment settings and builds the three L2 modes", () => {
  expect(
    environmentSchema.parse({ L1_RPC_URL: "", DEMO_MODE: "false" }),
  ).toMatchObject({
    L1_RPC_URL: undefined,
    L2_CHAIN_ID: 202610,
    BATCHER_MAX_CHANNEL_DURATION: 25,
    DEMO_MODE: false,
  });
  expect(
    environmentSchema.safeParse({
      L1_RPC_URL: "file:///tmp/chain",
      DEMO_MODE: "yes",
    }).success,
  ).toBe(false);
  expect(defineLedgerChain("anvil").id).toBe(31337);
  expect(defineLedgerChain("devnet").id).toBe(202610);
  expect(
    defineLedgerChain("devnet-ha", {
      rpcUrl: "http://rpc-proxy:8545",
      devnetChainId: 40501,
    }),
  ).toMatchObject({
    id: 40501,
    rpcUrls: { default: { http: ["http://rpc-proxy:8545"] } },
  });
});
