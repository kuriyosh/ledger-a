import { serve } from "@hono/node-server";
import { envSchema } from "./env.ts";
import { createApp } from "./routes/rpc.ts";

const env = envSchema.parse(process.env);
const app = createApp({
  l2: env.UPSTREAM_L2_RPC_URLS,
  rollup: env.UPSTREAM_ROLLUP_RPC_URLS,
});
serve({ fetch: app.fetch, port: env.PORT });
