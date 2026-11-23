import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readDeployment } from "@ledgera/config";
import { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { rawGateway } from "@ledgera/shared/raw-gateway";
import { serviceApp, startService } from "@ledgera/shared/server";
import { privateKeyToAccount } from "viem/accounts";
import {
  depositHash,
  depositInput,
  enforcementDemo,
  enforcementInput,
} from "./enforcement-demo.ts";
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
if (
  deployment.environment === "devnet" &&
  env.L1_RPC_URL &&
  env.L2_DIRECT_RPC_URL &&
  env.ATTACKER_PRIVATE_KEY
) {
  const enforcement = enforcementDemo(
    database,
    deployment,
    {
      l1: env.L1_RPC_URL,
      l2: env.L2_RPC_URL,
      direct: env.L2_DIRECT_RPC_URL,
      gateway: env.GATEWAY_URL,
    },
    env.ATTACKER_PRIVATE_KEY,
    env.ATTACKER_MAX_FEE_PER_GAS_WEI,
  );
  app.get("/v1/attacker/status", async (context) => {
    authorize(context.req.header("Authorization"));
    return context.json(await enforcement.status());
  });
  app.post("/v1/attacker/l1-deposit", async (context) => {
    authorize(context.req.header("Authorization"));
    const input = depositInput.safeParse(
      await context.req.json().catch(() => undefined),
    );
    const id = context.req.header("Idempotency-Key") ?? randomUUID();
    if (!input.success || !/^[A-Za-z0-9._-]{1,80}$/.test(id))
      throw new ServiceError(
        "INVALID_REQUEST",
        "Invalid demo deposit request",
        400,
      );
    return context.json(await enforcement.startDeposit(input.data, id), 201);
  });
  app.get("/v1/attacker/deposits/latest", async (context) => {
    authorize(context.req.header("Authorization"));
    return context.json(await enforcement.latestDeposit());
  });
  app.get("/v1/attacker/deposits/:hash", async (context) => {
    authorize(context.req.header("Authorization"));
    const hash = depositHash.safeParse(context.req.param("hash"));
    if (!hash.success)
      throw new ServiceError(
        "INVALID_REQUEST",
        "Invalid demo deposit hash",
        400,
      );
    return context.json(await enforcement.readDeposit(hash.data));
  });
  app.post("/v1/attacker/l2-send", async (context) => {
    authorize(context.req.header("Authorization"));
    const input = enforcementInput.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success)
      throw new ServiceError(
        "INVALID_REQUEST",
        "Invalid demo transaction",
        400,
      );
    return context.json(await enforcement.send(input.data));
  });
}

async function gatewayControl(
  path: "state" | "reorder-next",
  method: "GET" | "POST",
) {
  try {
    const response = await fetch(
      new URL(`/admin/demo/${path}`, env.GATEWAY_URL),
      {
        method,
        headers: {
          Authorization: `Bearer ${env.GATEWAY_ADMIN_TOKEN}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      },
    );
    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch {
    throw new ServiceError(
      "GATEWAY_UNAVAILABLE",
      "The demo Gateway is unavailable",
      503,
    );
  }
}
app.get("/v1/demo/state", (context) => {
  authorize(context.req.header("Authorization"));
  return gatewayControl("state", "GET");
});
app.post("/v1/demo/reorder-next", (context) => {
  authorize(context.req.header("Authorization"));
  return gatewayControl("reorder-next", "POST");
});
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
