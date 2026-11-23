import { fileURLToPath } from "node:url";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { serviceApp, startService } from "@ledgera/shared/server";
import { IndexerStore } from "./db/store.ts";
import { indexerEnv } from "./env.ts";
import { indexerRpc } from "./rpc.ts";
import { indexerSync } from "./sync.ts";

const env = indexerEnv.parse(process.env);
const deployment = await readDeployment(env.DEPLOYMENTS_FILE);
if (deployment.environment === "devnet" && !env.ROLLUP_RPC_URL)
  throw new Error("DevNet Indexer requires ROLLUP_RPC_URL");
const rpc = indexerRpc(
  env.L2_RPC_URL,
  deployment.environment === "anvil" ? "" : env.ROLLUP_RPC_URL,
);
if ((await rpc.chainId()) !== deployment.chainId)
  throw new Error("Indexer L2 chain ID does not match the deployment");

const migrations = fileURLToPath(new URL("./db/migrations/", import.meta.url));
const database = await openDatabase(env.DATABASE_URL, "indexer", migrations);
const store = new IndexerStore(database.db, env.INDEXER_START_BLOCK);
await store.initialize();
const indexer = indexerSync(
  store,
  rpc,
  env.INDEXER_START_BLOCK,
  env.POLL_INTERVAL_MS,
);
const controller = new AbortController();
const worker = indexer.run(controller.signal);
startService(serviceApp("indexer"), env, {
  onShutdown: () => controller.abort(),
  onClose: async () => {
    await worker;
    await database.close();
  },
});
