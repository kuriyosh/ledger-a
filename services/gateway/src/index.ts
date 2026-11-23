import { fileURLToPath } from "node:url";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { receiptGenesisHash } from "@ledgera/shared/receipt";
import { startService } from "@ledgera/shared/server";
import { privateKeyToAccount } from "viem/accounts";
import { runForwarder } from "./chain/forwarder.ts";
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
const signer = privateKeyToAccount(env.GATEWAY_PRIVATE_KEY);
const accept = createAdmission(
  store,
  admissionChain(client, deployment.contracts.kycRegistry),
  signer,
  policy,
);
const controller = new AbortController();
const forwarder = runForwarder(store, client, controller.signal);
const app = gatewayApp({
  chainId: deployment.chainId,
  genesisHash: receiptGenesisHash(policy),
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
