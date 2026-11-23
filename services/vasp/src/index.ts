import { fileURLToPath } from "node:url";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { startService } from "@ledgera/shared/server";
import { privateKeyToAccount } from "viem/accounts";
import { alertService } from "./alerts.ts";
import { registryChain, registryGateway } from "./chain.ts";
import { customerService } from "./customers.ts";
import { AlertStore } from "./db/alerts.ts";
import { VaspStore } from "./db/store.ts";
import { SwapStore } from "./db/swaps.ts";
import { TransferStore } from "./db/transfers.ts";
import { TravelRuleStore } from "./db/travel-rules.ts";
import { disclosureRoutes, disclosureStore } from "./disclosures.ts";
import { vaspEnv } from "./env.ts";
import { vaspApp } from "./http.ts";
import { quoteService } from "./quotes.ts";
import { swapChain } from "./swap-chain.ts";
import { swapService } from "./swaps.ts";
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
const transferStore = new TransferStore(database.db, vault);
const swapStore = new SwapStore(database.db);
const gateway = transferGateway(
  env.GATEWAY_URL,
  env.GATEWAY_API_KEY,
  deployments.contracts.ledgerForwarder,
);
const maker =
  env.MARKET_MAKER_ENABLED && env.TREASURY_PRIVATE_KEY
    ? {
        signer: privateKeyToAccount(env.TREASURY_PRIVATE_KEY),
        ttl: env.RFQ_TTL_SEC,
        rate: env.RFQ_RATE_JPY_PER_USD,
      }
    : undefined;
const quotes = quoteService(swapStore, chain, transferReader, deployments, {
  ownId: env.VASP_ID,
  vaspSigner: signer,
  makerId: env.MARKET_MAKER_VASP_ID,
  maker,
});
await quotes.verifyMaker();
const swaps = swapService(
  swapStore,
  transferStore,
  swapChain(chain.client, deployments, transferReader),
  gateway,
  env.DEMO_MODE,
);
const transfers = transferService(
  transferStore,
  transferReader,
  gateway,
  chain,
  travelRule,
  database.exclusive,
  swaps,
);
const alerts = alertService(
  new AlertStore(database.db),
  chain,
  {
    tUSD: deployments.contracts.tUSD,
    tJPY: deployments.contracts.tJPY,
  },
  {
    ownId: env.VASP_ID,
    signer,
    url: env.CONSORTIUM_URL,
    rules: {
      thresholds: {
        tUSD: env.AML_THRESHOLD_TUSD,
        tJPY: env.AML_THRESHOLD_TJPY,
      },
      watchlist: env.AML_WATCHLIST,
    },
  },
  database.exclusive,
);
const shutdown = new AbortController();
const polling = Promise.all([
  customers.poll(shutdown.signal),
  transfers.poll(shutdown.signal),
  alerts.poll(shutdown.signal),
]);
const app = vaspApp(
  store,
  customers,
  chain,
  env.ADMIN_TOKEN,
  transfers,
  travelRule,
  quotes,
  swaps,
  alerts,
  env.DEMO_MODE,
);
disclosureRoutes(app, disclosureStore(database.db), env.AUDITOR_API_KEY);
startService(app, env, {
  onShutdown: () => shutdown.abort(),
  onClose: async () => {
    await polling;
    await database.close();
  },
});
