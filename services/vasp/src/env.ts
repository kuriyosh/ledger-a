import { databaseUrl } from "@ledgera/shared/db";
import { serverEnv } from "@ledgera/shared/server";
import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });
const token = z.string().regex(/^\S+$/);
const privateKey = z.templateLiteral([
  "0x",
  z.string().regex(/^[a-fA-F0-9]{64}$/),
]);

export const vaspEnv = serverEnv
  .extend({
    PORT: serverEnv.shape.PORT.optional(),
    DATABASE_URL: databaseUrl,
    DEPLOYMENTS_FILE: z.string().min(1),
    L2_RPC_URL: httpUrl,
    GATEWAY_URL: httpUrl,
    GATEWAY_API_KEY: token,
    VASP_ID: z.coerce.number().pipe(z.union([z.literal(1), z.literal(2)])),
    VASP_NAME: z.string().min(1),
    CUSTOMER_ID_PREFIX: z.enum(["A", "B"]),
    VASP_ADMIN_PRIVATE_KEY: privateKey,
    VASP_SIGNER_PRIVATE_KEY: privateKey,
    VASP_KEY_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .transform((value) => Buffer.from(value, "hex")),
    ADMIN_TOKEN: token,
    AUDITOR_API_KEY: token,
    KYC_VALIDITY_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .max(36_500)
      .default(365),
    TRAVEL_RULE_AUTO_APPROVE: z.stringbool().default(false),
    TRAVEL_RULE_TTL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .max(86_400)
      .default(600),
    DEMO_MODE: z.stringbool().default(false),
  })
  .refine((env) => env.CUSTOMER_ID_PREFIX === (env.VASP_ID === 1 ? "A" : "B"), {
    path: ["CUSTOMER_ID_PREFIX"],
    message: "Customer ID prefix must match VASP_ID",
  })
  .transform((env) => ({
    ...env,
    PORT: env.PORT ?? 8620 + env.VASP_ID,
    schema: env.VASP_ID === 1 ? "vasp_a" : "vasp_b",
  }));
