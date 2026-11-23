import { databaseUrl } from "@ledgera/shared/db";
import { serverEnv } from "@ledgera/shared/server";
import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });
const uintString = z.string().regex(/^\d+$/).transform(BigInt);

export const gatewayEnv = serverEnv.extend({
  PORT: serverEnv.shape.PORT.default(8600),
  DATABASE_URL: databaseUrl,
  DEPLOYMENTS_FILE: z.string().min(1),
  SEQUENCER_RPC_URLS: z
    .string()
    .transform((value) => value.split(",").map((url) => url.trim()))
    .pipe(z.array(httpUrl).nonempty()),
  GATEWAY_PRIVATE_KEY: z.templateLiteral([
    "0x",
    z.string().regex(/^[a-fA-F0-9]{64}$/),
  ]),
  FIXED_PRIORITY_FEE_WEI: uintString.default(1n),
  GAS_LIMIT_CAP: uintString.default(5_000_000n),
  QUEUE_LIMIT: z.coerce.number().int().positive().default(1000),
});
