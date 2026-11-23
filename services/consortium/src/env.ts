import { databaseUrl } from "@ledgera/shared/db";
import { serverEnv } from "@ledgera/shared/server";
import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });
const key = z.templateLiteral(["0x", z.string().regex(/^[a-fA-F0-9]{64}$/)]);
const memberKeys = z
  .string()
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: "custom",
        message: "Expected a JSON array of keys",
      });
      return z.NEVER;
    }
  })
  .pipe(z.tuple([key, key, key]));
const memberNames = z
  .string()
  .default("構成員 1,構成員 2,構成員 3")
  .transform((value) => value.split(",").map((name) => name.trim()))
  .pipe(z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]));

export const consortiumEnv = serverEnv.extend({
  PORT: serverEnv.shape.PORT.default(8630),
  DATABASE_URL: databaseUrl,
  DEPLOYMENTS_FILE: z.string().min(1),
  L2_RPC_URL: httpUrl,
  GATEWAY_URL: httpUrl,
  ADMIN_TOKEN: z.string().regex(/^\S+$/),
  CONSORTIUM_MEMBER_KEYS: memberKeys,
  CONSORTIUM_MEMBER_NAMES: memberNames,
});
