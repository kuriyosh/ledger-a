import { fileURLToPath } from "node:url";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { startService } from "@ledgera/shared/server";
import { AuditStore } from "./db/store.ts";
import { auditorEnv } from "./env.ts";
import { auditorApp } from "./http.ts";
import { createAuditRunner } from "./run.ts";
import { auditSource, gatewaySource } from "./sources.ts";
import { traceRoutes } from "./trace.ts";

const env = auditorEnv.parse(process.env);
const deployment = await readDeployment(env.DEPLOYMENTS_FILE);
const source = auditSource(deployment, env.AUDIT_RPC_URL);
if ((await source.chainId()) !== deployment.chainId) {
  throw new Error("Audit RPC chain ID does not match the deployment");
}
const migrations = fileURLToPath(new URL("./db/migrations/", import.meta.url));
const database = await openDatabase(env.DATABASE_URL, "auditor", migrations);
const store = new AuditStore(database.db);
const controller = new AbortController();
const runner = createAuditRunner({
  source,
  gateway: gatewaySource(env.GATEWAY_URL),
  store,
  startBlock: BigInt(deployment.auditStartBlock),
  intervalMs: env.AUDIT_INTERVAL_SEC * 1000,
  inclusionDeadlineMs: BigInt(env.INCLUSION_DEADLINE_SEC) * 1000n,
  timeToleranceMs: BigInt(env.TIME_TOLERANCE_SEC) * 1000n,
  signal: controller.signal,
});
const polling = runner.poll();
const peers = new Map<number, { url: string; apiKey: string }>();
if (env.VASP_A_URL && env.VASP_A_AUDITOR_KEY)
  peers.set(deployment.vasps.a, {
    url: env.VASP_A_URL,
    apiKey: env.VASP_A_AUDITOR_KEY,
  });
if (env.VASP_B_URL && env.VASP_B_AUDITOR_KEY)
  peers.set(deployment.vasps.b, {
    url: env.VASP_B_URL,
    apiKey: env.VASP_B_AUDITOR_KEY,
  });
const app = auditorApp(store, runner.run);
traceRoutes(app, database.db, env.INDEXER_URL, peers, env.AUDITOR_ADMIN_TOKEN);
startService(app, env, {
  onShutdown: () => controller.abort(),
  onClose: async () => {
    await polling;
    await database.close();
  },
});
