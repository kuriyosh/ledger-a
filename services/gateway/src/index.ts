import { fileURLToPath } from "node:url";
import { receiptLogAbi } from "@ledgera/abis";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { receiptGenesisHash } from "@ledgera/shared/receipt";
import { logService, startService } from "@ledgera/shared/server";
import { privateKeyToAccount } from "viem/accounts";
import { createCommitter } from "./chain/commit.ts";
import { conductorCluster } from "./chain/conductor.ts";
import { ForwardNotifications, runForwarder } from "./chain/forwarder.ts";
import { createInclusionTracker } from "./chain/inclusion.ts";
import { relayChain } from "./chain/relay.ts";
import { admissionChain, connectSequencer } from "./chain/sequencer.ts";
import { GatewayStore } from "./db/store.ts";
import { createAdmission } from "./domain/admission.ts";
import { createRelayAuth } from "./domain/relay.ts";
import { gatewayEnv } from "./env.ts";
import { demoRoutes } from "./routes/demo.ts";
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
const cluster =
  env.CONDUCTOR_RPC_URLS &&
  conductorCluster(
    env.CONDUCTOR_RPC_URLS.map((conductor, index) => ({
      id: `sequencer-${String(index + 1)}`,
      conductor,
      rpc: env.SEQUENCER_RPC_URLS[index],
    })),
  );
async function selectLeader() {
  const view = await cluster?.();
  if (!view?.selected) throw new Error("No active sequencer leader");
  return view.selected;
}
let lastLeader: string | undefined;
const client = connectSequencer(
  deployment,
  env.SEQUENCER_RPC_URLS[0],
  cluster &&
    (async (method) => {
      const peer = await selectLeader();
      if (method === "eth_sendRawTransaction" && peer.id !== lastLeader) {
        throw new Error("Sequencer leader changed before forwarding");
      }
      return peer.rpc;
    }),
);
const readUrl = env.SEQUENCER_READ_RPC_URL;
const reading =
  cluster && readUrl
    ? connectSequencer(
        deployment,
        readUrl,
        async () => (await cluster()).selected?.rpc ?? readUrl,
      )
    : client;
if ((await reading.getChainId()) !== deployment.chainId) {
  throw new Error("Sequencer chain ID does not match the deployment");
}

const configuredSigner = await reading.readContract({
  address: deployment.contracts.receiptLog,
  abi: receiptLogAbi,
  functionName: "gatewaySigner",
});
if (configuredSigner.toLowerCase() !== signer.address.toLowerCase()) {
  throw new Error("Gateway key does not match ReceiptLog.gatewaySigner");
}

const migrations = fileURLToPath(new URL("./db/migrations/", import.meta.url));
const database = await openDatabase(env.DATABASE_URL, "gateway", migrations);
const store = new GatewayStore(database.db, env.DEMO_MODE);
if (!env.DEMO_MODE) await store.disableDemo();
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
  admissionChain(reading, deployment.contracts.kycRegistry),
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
    const leader = cluster ? (await selectLeader()).id : undefined;
    if (!(await synchronize(leader !== lastLeader))) {
      throw new Error("Waiting for sequencer canonical chain");
    }
    if (cluster && (await selectLeader()).id !== leader) {
      throw new Error("Sequencer leader changed during synchronization");
    }
    lastLeader = leader;
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
    const [head, queueLength, committed, view] = await Promise.all([
      store.head(),
      store.queueLength(),
      store.lastConfirmedSeq(),
      cluster?.(),
    ]);
    const endpoint =
      view?.selected?.rpc ?? (cluster ? null : env.SEQUENCER_RPC_URLS[0]);
    return {
      sequencerUrl: endpoint && new URL(endpoint).origin,
      leader: view?.selected?.id ?? null,
      ...(view && { sequencers: view.nodes }),
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
      reading,
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
if (env.DEMO_MODE && env.ADMIN_TOKEN) {
  app.route("/", demoRoutes(store, env.ADMIN_TOKEN));
}
startService(app, env, {
  onShutdown: () => controller.abort(),
  onClose: async () => {
    await forwarder;
    await database.close();
  },
});
