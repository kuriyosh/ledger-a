import { serve } from "@hono/node-server";
import { envSchema } from "./env.ts";
import { createApp } from "./routes/rpc.ts";

const env = envSchema.parse(process.env);
const app = createApp({
  l2: env.UPSTREAM_L2_RPC_URLS,
  rollup: env.UPSTREAM_ROLLUP_RPC_URLS,
});
const server = serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close());
}
