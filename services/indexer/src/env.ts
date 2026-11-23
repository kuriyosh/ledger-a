import { databaseUrl } from "@ledgera/shared/db";
import { serverEnv } from "@ledgera/shared/server";
import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });

export const indexerEnv = serverEnv.extend({
  PORT: serverEnv.shape.PORT.default(8640),
  DATABASE_URL: databaseUrl,
  DEPLOYMENTS_FILE: z.string().min(1),
  L2_RPC_URL: httpUrl,
  ROLLUP_RPC_URL: z.union([httpUrl, z.literal("")]).default(""),
  INDEXER_START_BLOCK: z.string().regex(/^\d+$/).transform(BigInt).default(0n),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
});
