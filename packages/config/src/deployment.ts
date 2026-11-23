import { readFile } from "node:fs/promises";
import { getAddress, isAddress } from "viem";
import { sepolia } from "viem/chains";
import { z } from "zod";
import { ANVIL_CHAIN_ID, devnetChainIdSchema } from "./env.ts";

const address = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), {
    message: "Expected an Ethereum address",
  })
  .transform((value) => getAddress(value));

const deploymentFields = {
  enforcementBlock: z.number().int().nonnegative(),
  auditStartBlock: z.number().int().positive(),
  contracts: z.object({
    kycRegistry: address,
    ledgerForwarder: address,
    travelRuleCompliance: address,
    tJPY: address,
    tUSD: address,
    atomicSwap: address,
    receiptLog: address,
    depositProbe: address,
    consortiumSafe: address,
  }),
  vasps: z.object({ network: z.literal(0), a: z.literal(1), b: z.literal(2) }),
};

export const deploymentSchema = z
  .discriminatedUnion("environment", [
    z.object({
      ...deploymentFields,
      environment: z.literal("anvil"),
      chainId: z.literal(ANVIL_CHAIN_ID),
      l1: z.never().optional(),
    }),
    z.object({
      ...deploymentFields,
      environment: z.literal("devnet"),
      chainId: z
        .number()
        .int()
        .positive()
        .refine((id) => id !== sepolia.id),
      l1: z.object({
        chainId: z.literal(sepolia.id),
        optimismPortal: address,
        systemConfig: address,
      }),
    }),
  ])
  .refine((value) => value.auditStartBlock > value.enforcementBlock, {
    message: "The audit start block must follow the enforcement block",
    path: ["auditStartBlock"],
  });

export type Deployment = z.infer<typeof deploymentSchema>;

export async function readDeployment(path: string): Promise<Deployment> {
  return deploymentSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
