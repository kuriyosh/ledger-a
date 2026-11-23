import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });
const endpoints = z
  .string()
  .transform((value) =>
    value.length ? value.split(",").map((url) => url.trim()) : [],
  );

export const envSchema = z
  .object({
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8545),
    UPSTREAM_L2_RPC_URLS: endpoints.pipe(z.array(httpUrl).min(1)),
    UPSTREAM_ROLLUP_RPC_URLS: endpoints.pipe(z.array(httpUrl)).prefault(""),
  })
  .refine(
    (value) =>
      value.UPSTREAM_ROLLUP_RPC_URLS.length === 0 ||
      value.UPSTREAM_L2_RPC_URLS.length ===
        value.UPSTREAM_ROLLUP_RPC_URLS.length,
    {
      path: ["UPSTREAM_ROLLUP_RPC_URLS"],
      message: "Each rollup endpoint must have a paired L2 endpoint",
    },
  );
