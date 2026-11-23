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
  AUDITOR_ADMIN_TOKEN: z.string().regex(/^\S+$/).optional(),
  INDEXER_URL: httpUrl.default("http://127.0.0.1:8640"),
  VASP_A_URL: httpUrl.optional(),
  VASP_B_URL: httpUrl.optional(),
  VASP_A_AUDITOR_KEY: z.string().regex(/^\S+$/).optional(),
  VASP_B_AUDITOR_KEY: z.string().regex(/^\S+$/).optional(),
  INCLUSION_DEADLINE_SEC: z.coerce.number().int().positive().default(120),
  TIME_TOLERANCE_SEC: z.coerce.number().int().nonnegative().default(5),
  AUDIT_INTERVAL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .max(86_400)
    .default(10),
});
