import { fileURLToPath } from "node:url";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { rawGateway } from "@ledgera/shared/raw-gateway";
import { startService } from "@ledgera/shared/server";
import { privateKeyToAccount } from "viem/accounts";
import { ConsortiumStore } from "./db/store.ts";
import { consortiumEnv } from "./env.ts";
import { consortiumApp } from "./http.ts";
import { consortiumChain, type Member } from "./safe.ts";
import { consortiumService } from "./service.ts";

const env = consortiumEnv.parse(process.env);
const deployment = await readDeployment(env.DEPLOYMENTS_FILE);
const memberIds = [1, 2, 3] as const;
const members: Member[] = memberIds.map((id) => ({
  id,
  name: env.CONSORTIUM_MEMBER_NAMES[id - 1],
  account: privateKeyToAccount(env.CONSORTIUM_MEMBER_KEYS[id - 1]),
}));
const chain = consortiumChain(deployment, env.L2_RPC_URL, members);
await chain.verify();

const migrations = fileURLToPath(new URL("./db/migrations/", import.meta.url));
const database = await openDatabase(env.DATABASE_URL, "consortium", migrations);
const service = consortiumService(
  new ConsortiumStore(database.db),
  chain,
  rawGateway(env.GATEWAY_URL),
  deployment.contracts.kycRegistry,
  members,
);
const controller = new AbortController();
const worker = service.poll(controller.signal);
startService(consortiumApp(service, chain, members, env.ADMIN_TOKEN), env, {
  onShutdown: () => controller.abort(),
  onClose: async () => {
    await worker;
    await database.close();
  },
});
