import { databaseUrl } from "@ledgera/shared/db";
import { serverEnv } from "@ledgera/shared/server";
import { z } from "zod";

const url = z.url({ protocol: /^https?$/ });
const privateKey = z.templateLiteral([
  "0x",
  z.string().regex(/^[a-fA-F0-9]{64}$/),
]);
const bearer = z.string().regex(/^\S+$/);
export const demoEnv = serverEnv.extend({
  PORT: serverEnv.shape.PORT.default(8660),
  DEMO_MODE: z.stringbool().pipe(z.literal(true)),
  DATABASE_URL: databaseUrl,
  DEPLOYMENTS_FILE: z.string().min(1),
  L2_RPC_URL: url,
  GATEWAY_URL: url,
  ISSUER_PRIVATE_KEY: privateKey,
  ATTACKER_PRIVATE_KEY: privateKey.optional(),
  L1_RPC_URL: url.optional(),
  L2_DIRECT_RPC_URL: url.optional(),
  ATTACKER_MAX_FEE_PER_GAS_WEI: z
    .string()
    .regex(/^\d{1,12}$/)
    .transform(BigInt)
    .refine((fee) => fee > 0n && fee <= 100_000_000_000n)
    .default(3_000_000_000n),
  GATEWAY_ADMIN_TOKEN: bearer,
  VASP_A_URL: url,
  VASP_B_URL: url,
  VASP_A_ADMIN_TOKEN: bearer,
  VASP_B_ADMIN_TOKEN: bearer,
});
