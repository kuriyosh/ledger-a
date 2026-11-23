import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { rawGateway } from "@ledgera/shared/raw-gateway";
import { serviceApp, startService } from "@ledgera/shared/server";
import { privateKeyToAccount } from "viem/accounts";
import { demoEnv } from "./env.ts";
import { mintChain, mintInput, mintService } from "./mint.ts";
import { runService } from "./runs.ts";

const env = demoEnv.parse(process.env);
const deployment = await readDeployment(env.DEPLOYMENTS_FILE);
const chain = mintChain(
  deployment,
  env.L2_RPC_URL,
  privateKeyToAccount(env.ISSUER_PRIVATE_KEY),
);
await chain.verify();

const migrations = fileURLToPath(new URL("./db/migrations/", import.meta.url));
const database = await openDatabase(env.DATABASE_URL, "demo", migrations);
const mint = mintService(database, chain, rawGateway(env.GATEWAY_URL));
const runs = runService(
  database,
  env.GATEWAY_URL,
  {
    A: { url: env.VASP_A_URL, adminToken: env.VASP_A_ADMIN_TOKEN },
    B: { url: env.VASP_B_URL, adminToken: env.VASP_B_ADMIN_TOKEN },
  },
  chain.latest,
  mint,
);

const hash = (value: string) => createHash("sha256").update(value).digest();
const tokenHash = hash(`Bearer ${env.GATEWAY_ADMIN_TOKEN}`);
function authorize(header?: string) {
  if (!timingSafeEqual(hash(header ?? ""), tokenHash))
    throw new ServiceError(
      "UNAUTHORIZED",
      "Demo administrator token required",
      401,
    );
}

const app = serviceApp("demo-tools");
app.post("/v1/issuer/mint", async (context) => {
  authorize(context.req.header("Authorization"));
  const input = mintInput.safeParse(
    await context.req.json().catch(() => undefined),
  );
  const key = context.req.header("Idempotency-Key") ?? randomUUID();
  if (!input.success || !/^[A-Za-z0-9._-]{1,80}$/.test(key))
    throw new ServiceError("INVALID_REQUEST", "Invalid mint request", 400);
  return context.json(await mint(`api:${key}`, input.data), 201);
});
app.post("/v1/demo/runs", async (context) => {
  authorize(context.req.header("Authorization"));
  return context.json(await runs.start(), 201);
});
app.get("/v1/demo/runs/current", async (context) =>
  context.json(await runs.current()),
);
startService(app, env, { onClose: database.close });
