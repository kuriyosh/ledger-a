import { fileURLToPath } from "node:url";
import { receiptLogAbi } from "@ledgera/abis";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { receiptGenesisHash } from "@ledgera/shared/receipt";
import { startService } from "@ledgera/shared/server";
import { privateKeyToAccount } from "viem/accounts";
import { ForwardNotifications, runForwarder } from "./chain/forwarder.ts";
import { admissionChain, connectSequencer } from "./chain/sequencer.ts";
import { GatewayStore } from "./db/store.ts";
import { createAdmission } from "./domain/admission.ts";
import { gatewayEnv } from "./env.ts";
import { gatewayApp } from "./routes/gateway.ts";

const env = gatewayEnv.parse(process.env);
const deployment = await readDeployment(env.DEPLOYMENTS_FILE);
const client = connectSequencer(deployment, env.SEQUENCER_RPC_URLS[0]);
if ((await client.getChainId()) !== deployment.chainId) {
  throw new Error("Sequencer chain ID does not match the deployment");
}

const signer = privateKeyToAccount(env.GATEWAY_PRIVATE_KEY);
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
const accept = createAdmission(
  store,
  admissionChain(client, deployment.contracts.kycRegistry),
  signer,
  policy,
);
const controller = new AbortController();
const notifications = new ForwardNotifications();
const forwarder = runForwarder(store, client, notifications, controller.signal);
const app = gatewayApp({
  chainId: deployment.chainId,
  genesisHash,
  notifications,
  store,
  accept,
  signal: controller.signal,
});
startService(app, env, {
  onShutdown: () => controller.abort(),
  onClose: async () => {
    await forwarder;
    await database.close();
  },
});
