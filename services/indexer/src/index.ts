import { fileURLToPath } from "node:url";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { serviceApp, startService } from "@ledgera/shared/server";
import { IndexerStore } from "./db/store.ts";
import { decoder } from "./decode.ts";
import { indexerEnv } from "./env.ts";
import { failureWorker } from "./failures.ts";
import { indexerRoutes } from "./http.ts";
import { chainQuery } from "./query.ts";
import { registryQuery } from "./registry-query.ts";
import { indexerRpc } from "./rpc.ts";
import { chainState } from "./state.ts";
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

const state = chainState(env.L2_RPC_URL, deployment.contracts);
if (env.INDEXER_START_BLOCK > 0n) {
  const parent = env.INDEXER_START_BLOCK - 1n;
  if (parent <= (await rpc.latest())) {
    try {
      await state.registry((await rpc.header(parent)).hash);
    } catch (error) {
      throw new Error(
        "Partial indexing requires historical L2 state at the start block",
        { cause: error },
      );
    }
  }
}

const migrations = fileURLToPath(new URL("./db/migrations/", import.meta.url));
const database = await openDatabase(env.DATABASE_URL, "indexer", migrations);
const decode = decoder(deployment.contracts);
const store = new IndexerStore(database.db, env.INDEXER_START_BLOCK, {
  decode,
  state,
  tokens: deployment.contracts,
});
await store.initialize();
const indexer = indexerSync(
  store,
  rpc,
  env.INDEXER_START_BLOCK,
  env.POLL_INTERVAL_MS,
);
const controller = new AbortController();
const failures = failureWorker(database.db, deployment, env.L2_RPC_URL, rpc);
const worker = Promise.all([
  indexer.run(controller.signal),
  failures.run(controller.signal),
]);
const app = serviceApp("indexer");
indexerRoutes(
  app,
  chainQuery(database.db, decode),
  registryQuery(database.db, deployment, env.L2_RPC_URL, state),
  deployment.contracts,
);
startService(app, env, {
  onShutdown: () => controller.abort(),
  onClose: async () => {
    await worker;
    await database.close();
  },
});
