import { fileURLToPath } from "node:url";
import { receiptLogAbi } from "@ledgera/abis";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { receiptGenesisHash } from "@ledgera/shared/receipt";
import { logService, startService } from "@ledgera/shared/server";
import { privateKeyToAccount } from "viem/accounts";
import { createCommitter } from "./chain/commit.ts";
import { ForwardNotifications, runForwarder } from "./chain/forwarder.ts";
import { createInclusionTracker } from "./chain/inclusion.ts";
import { relayChain } from "./chain/relay.ts";
import { admissionChain, connectSequencer } from "./chain/sequencer.ts";
import { GatewayStore } from "./db/store.ts";
import { createAdmission } from "./domain/admission.ts";
import { createRelayAuth } from "./domain/relay.ts";
import { gatewayEnv } from "./env.ts";
import { gatewayApp } from "./routes/gateway.ts";
import { relayRoutes } from "./routes/relay.ts";

const env = gatewayEnv.parse(process.env);
const relayers = new Map(
  Object.entries(env.RELAYER_KEYS).map(([id, key]) => [
    Number(id),
    privateKeyToAccount(key),
  ]),
);
const signer = privateKeyToAccount(env.GATEWAY_PRIVATE_KEY);
const relayerAddresses = new Set(
  Array.from(relayers.values(), (relayer) => relayer.address),
);
if (
  relayerAddresses.size !== relayers.size ||
  relayerAddresses.has(signer.address)
) {
  throw new Error(
    "Each relayer must have its own key separate from the Gateway signer",
  );
}
const vaspKeys = Object.values(env.VASP_API_KEYS);
if (
  new Set(vaspKeys).size !== vaspKeys.length ||
  Object.keys(env.VASP_API_KEYS).some((id) => !relayers.has(Number(id)))
)
  throw new Error("VASP API keys must be unique and each must have a relayer");
const deployment = await readDeployment(env.DEPLOYMENTS_FILE);
const client = connectSequencer(deployment, env.SEQUENCER_RPC_URLS[0]);
if ((await client.getChainId()) !== deployment.chainId) {
  throw new Error("Sequencer chain ID does not match the deployment");
}

const configuredSigner = await client.readContract({
  address: deployment.contracts.receiptLog,
  abi: receiptLogAbi,
  functionName: "gatewaySigner",
});
if (configuredSigner.toLowerCase() !== signer.address.toLowerCase()) {
  throw new Error("Gateway key does not match ReceiptLog.gatewaySigner");
}

const migrations = fileURLToPath(new URL("./db/migrations/", import.meta.url));
const database = await openDatabase(env.DATABASE_URL, "gateway", migrations);
const store = new GatewayStore(database.db);
const policy = {
  chainId: deployment.chainId,
  verifyingContract: deployment.contracts.receiptLog,
  fixedPriorityFee: env.FIXED_PRIORITY_FEE_WEI,
  gasLimit: env.GAS_LIMIT_CAP,
  queueLimit: env.QUEUE_LIMIT,
};
const genesisHash = receiptGenesisHash(policy);
const first = await store.firstReceipt();
if (first && first.prevHash !== genesisHash) {
  await database.close();
  throw new Error(
    "Stored Receipt genesis does not match the configured deployment",
  );
}
const admission = createAdmission(
  store,
  admissionChain(client, deployment.contracts.kycRegistry),
  signer,
  policy,
);
const controller = new AbortController();
const notifications = new ForwardNotifications();
const synchronize = createInclusionTracker(
  client,
  store,
  BigInt(deployment.auditStartBlock),
  (seq) => notifications.publish(seq, { status: "forwarded", error: null }),
);
const commit = createCommitter(client, store, admission, signer, {
  address: deployment.contracts.receiptLog,
  chainId: deployment.chainId,
  intervalMs: env.COMMIT_INTERVAL_SEC * 1000,
  maxFee: env.MAX_FEE_PER_GAS_WEI,
  priorityFee: env.FIXED_PRIORITY_FEE_WEI,
});
const forwarder = runForwarder(
  store,
  client,
  notifications,
  controller.signal,
  async () => {
    await synchronize();
    try {
      await commit();
    } catch (error) {
      logService(
        "gateway",
        "error",
        "Receipt commitment did not advance",
        null,
        {
          errorName: error instanceof Error ? error.name : "Error",
        },
      );
    }
  },
);
const app = gatewayApp({
  chainId: deployment.chainId,
  genesisHash,
  notifications,
  store,
  accept: admission.accept,
  async status() {
    const [head, queueLength, committed] = await Promise.all([
      store.head(),
      store.queueLength(),
      store.lastConfirmedSeq(),
    ]);
    return {
      sequencerUrl: new URL(env.SEQUENCER_RPC_URLS[0]).origin,
      leader: null,
      queueLength,
      lastSeq: (head?.seq ?? 0n).toString(),
      lastCommittedSeq: committed.toString(),
    };
  },
  signal: controller.signal,
});
app.route(
  "/",
  relayRoutes({
    authorize: createRelayAuth(env.VASP_API_KEYS, env.RELAY_RATE_LIMIT_PER_MIN),
    relayers,
    chain: relayChain(
      client,
      deployment.contracts.kycRegistry,
      deployment.contracts.ledgerForwarder,
    ),
    stores: { receipts: store, notifications },
    admission,
    signal: controller.signal,
    policy: {
      chainId: deployment.chainId,
      forwarder: deployment.contracts.ledgerForwarder,
      tokenAddresses: [deployment.contracts.tJPY, deployment.contracts.tUSD],
      swap: deployment.contracts.atomicSwap,
      maxFee: env.MAX_FEE_PER_GAS_WEI,
      fixedPriorityFee: env.FIXED_PRIORITY_FEE_WEI,
      fallbackGas: env.RELAY_FALLBACK_GAS,
      gasLimit: env.GAS_LIMIT_CAP,
    },
  }),
);
startService(app, env, {
  onShutdown: () => controller.abort(),
  onClose: async () => {
    await forwarder;
    await database.close();
  },
});
