import { databaseUrl } from "@ledgera/shared/db";
import { serverEnv } from "@ledgera/shared/server";
import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });
const uintString = z.string().regex(/^\d+$/).transform(BigInt);

const privateKey = z.templateLiteral([
  "0x",
  z.string().regex(/^[a-fA-F0-9]{64}$/),
]);
const vaspKey = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/)
  .refine((value) => Number(value) <= 0x7fff_ffff);
function vaspMapping<Schema extends z.ZodType>(value: Schema) {
  return z
    .string()
    .transform((text, context): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        context.addIssue({
          code: "custom",
          message: "Expected a JSON object of VASP IDs",
        });
        return z.NEVER;
      }
    })
    .pipe(z.record(vaspKey, value));
}

export const gatewayEnv = serverEnv.extend({
  PORT: serverEnv.shape.PORT.default(8600),
  DATABASE_URL: databaseUrl,
  DEPLOYMENTS_FILE: z.string().min(1),
  SEQUENCER_RPC_URLS: z
    .string()
    .transform((value) => value.split(",").map((url) => url.trim()))
    .pipe(z.array(httpUrl).nonempty()),
  GATEWAY_PRIVATE_KEY: privateKey,
  RELAYER_KEYS: vaspMapping(privateKey).default({}),
  VASP_API_KEYS: vaspMapping(z.string().regex(/^\S+$/)).default({}),
  MAX_FEE_PER_GAS_WEI: uintString.default(100_000_000_000n),
  RELAY_FALLBACK_GAS: uintString.default(1_000_000n),
  RELAY_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  FIXED_PRIORITY_FEE_WEI: uintString.default(1n),
  GAS_LIMIT_CAP: uintString.default(5_000_000n),
  QUEUE_LIMIT: z.coerce.number().int().positive().default(1000),
});
