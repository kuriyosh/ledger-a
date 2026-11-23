import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8545),
  UPSTREAM_L2_RPC_URLS: httpUrl,
  UPSTREAM_ROLLUP_RPC_URLS: z
    .union([httpUrl, z.literal("")])
    .optional()
    .transform((value) => value || undefined),
});
