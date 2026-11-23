import { sepolia } from "viem/chains";
import { z } from "zod";

export const ANVIL_CHAIN_ID = 31337;
export const DEFAULT_DEVNET_CHAIN_ID = 202610;

export const devnetChainIdSchema = z
  .number()
  .int()
  .positive()
  .refine((id) => id !== sepolia.id);

const httpUrl = z.url({ protocol: /^https?$/ });
const optionalHttpUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  httpUrl.optional(),
);

export const environmentSchema = z.object({
  L1_RPC_URL: optionalHttpUrl,
  L1_BEACON_URL: httpUrl.default(
    "https://ethereum-sepolia-beacon-api.publicnode.com",
  ),
  L2_CHAIN_ID: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_DEVNET_CHAIN_ID),
  BATCHER_MAX_CHANNEL_DURATION: z.coerce.number().int().positive().default(25),
  DEMO_MODE: z.stringbool({ truthy: ["true"], falsy: ["false"] }).default(true),
});
