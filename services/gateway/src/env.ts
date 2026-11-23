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

export const gatewayEnv = serverEnv
  .extend({
    PORT: serverEnv.shape.PORT.default(8600),
    DATABASE_URL: databaseUrl,
    DEMO_MODE: z.stringbool().default(false),
    ADMIN_TOKEN: z.string().regex(/^\S+$/).optional(),
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
    GAS_LIMIT_CAP: uintString.refine((value) => value > 0n).default(5_000_000n),
    COMMIT_INTERVAL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .max(86_400)
      .default(30),
    QUEUE_LIMIT: z.coerce.number().int().positive().default(1000),
  })
  .refine(
    ({ RELAY_FALLBACK_GAS, GAS_LIMIT_CAP }) =>
      RELAY_FALLBACK_GAS > 0n && RELAY_FALLBACK_GAS <= GAS_LIMIT_CAP,
    {
      path: ["RELAY_FALLBACK_GAS"],
      message: "Expected gas in the range 1..GAS_LIMIT_CAP",
    },
  )
  .refine(
    ({ MAX_FEE_PER_GAS_WEI, FIXED_PRIORITY_FEE_WEI }) =>
      MAX_FEE_PER_GAS_WEI > 0n &&
      MAX_FEE_PER_GAS_WEI < 1n << 256n &&
      MAX_FEE_PER_GAS_WEI >= FIXED_PRIORITY_FEE_WEI,
    {
      path: ["MAX_FEE_PER_GAS_WEI"],
      message:
        "Expected a positive uint256 fee cap at or above FIXED_PRIORITY_FEE_WEI",
    },
  )
  .refine((env) => !env.DEMO_MODE || env.ADMIN_TOKEN !== undefined, {
    path: ["ADMIN_TOKEN"],
    message: "Expected ADMIN_TOKEN when DEMO_MODE is enabled",
  });
