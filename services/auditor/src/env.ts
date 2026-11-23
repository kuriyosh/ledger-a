import { databaseUrl } from "@ledgera/shared/db";
import { serverEnv } from "@ledgera/shared/server";
import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });

export const auditorEnv = serverEnv.extend({
  PORT: serverEnv.shape.PORT.default(8650),
  DATABASE_URL: databaseUrl,
  DEPLOYMENTS_FILE: z.string().min(1),
  AUDIT_RPC_URL: httpUrl,
  GATEWAY_URL: httpUrl,
  INCLUSION_DEADLINE_SEC: z.coerce.number().int().positive().default(120),
  TIME_TOLERANCE_SEC: z.coerce.number().int().nonnegative().default(5),
  AUDIT_INTERVAL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .max(86_400)
    .default(10),
});
