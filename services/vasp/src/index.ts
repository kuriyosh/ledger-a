import { fileURLToPath } from "node:url";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { startService } from "@ledgera/shared/server";
import { privateKeyToAccount } from "viem/accounts";
import { registryChain, registryGateway } from "./chain.ts";
import { customerService } from "./customers.ts";
import { VaspStore } from "./db/store.ts";
import { TransferStore } from "./db/transfers.ts";
import { TravelRuleStore } from "./db/travel-rules.ts";
import { vaspEnv } from "./env.ts";
import { vaspApp } from "./http.ts";
import { transferChain } from "./transfer-chain.ts";
import { transferGateway } from "./transfer-gateway.ts";
import { transferService } from "./transfers.ts";
import { travelRuleService } from "./travel-rules.ts";
import { createWalletVault } from "./wallet-vault.ts";

const env = vaspEnv.parse(process.env);
const deployments = await readDeployment(env.DEPLOYMENTS_FILE);
const admin = privateKeyToAccount(env.VASP_ADMIN_PRIVATE_KEY);
const signer = privateKeyToAccount(env.VASP_SIGNER_PRIVATE_KEY);
const chain = registryChain(deployments, env.L2_RPC_URL, admin);
if ((await chain.client.getChainId()) !== deployments.chainId) {
  throw new Error("VASP RPC chain ID does not match the deployment");
}
const vasp = await chain.vasp(env.VASP_ID);
if (
  vasp.admin.toLowerCase() !== admin.address.toLowerCase() ||
  vasp.travelRuleSigner.toLowerCase() !== signer.address.toLowerCase()
) {
  throw new Error("VASP keys do not match KycRegistry");
}

const migrations = fileURLToPath(new URL("./db/migrations/", import.meta.url));
const database = await openDatabase(env.DATABASE_URL, env.schema, migrations);
const vault = createWalletVault(env.VASP_KEY_ENCRYPTION_KEY);
const store = new VaspStore(database.db, env.CUSTOMER_ID_PREFIX, vault);
await store.verifyWalletKey();
const customers = customerService(
  store,
  chain,
  registryGateway(env.GATEWAY_URL),
  env.KYC_VALIDITY_DAYS,
);
const transferReader = transferChain(chain.client, deployments);
const travelRule = travelRuleService(
  new TravelRuleStore(database.db),
  store,
  chain,
  transferReader,
  deployments,
  env.VASP_ID,
  signer,
  env.TRAVEL_RULE_AUTO_APPROVE,
  env.TRAVEL_RULE_TTL_SEC,
);
const transfers = transferService(
  new TransferStore(database.db, vault),
  transferReader,
  transferGateway(
    env.GATEWAY_URL,
    env.GATEWAY_API_KEY,
    deployments.contracts.ledgerForwarder,
  ),
  chain,
  travelRule,
  database.exclusive,
);
const shutdown = new AbortController();
const polling = Promise.all([
  customers.poll(shutdown.signal),
  transfers.poll(shutdown.signal),
]);
startService(
  vaspApp(
    store,
    customers,
    chain,
    env.ADMIN_TOKEN,
    transfers,
    travelRule,
    env.DEMO_MODE,
  ),
  env,
  {
    onShutdown: () => shutdown.abort(),
    onClose: async () => {
      await polling;
      await database.close();
    },
  },
);
