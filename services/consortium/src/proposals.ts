import { kycRegistryAbi } from "@ledgera/abis";
import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
  isAddress,
} from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine((value) => isAddress(value, { strict: false }))
  .transform((value) => getAddress(value.toLowerCase()));
const bytes = z
  .string()
  .regex(/^0x(?:[a-fA-F0-9]{2})*$/)
  .transform((value) => value.toLowerCase() as Hex);
const bytes32 = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
export const vaspId = z.int().min(1).max(0x7fff_ffff);
export const memberId = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const memberInput = z.object({ memberId });
const common = {
  reason: z.string().trim().min(1).max(500),
  requestedBy: z
    .union([z.object({ vaspId }), z.object({ memberId })])
    .optional(),
};
export const proposalInput = z.discriminatedUnion("type", [
  z.object({
    ...common,
    type: z.literal("BLOCK_ACCOUNT"),
    params: z.object({ account: address, reasonId: bytes32 }),
  }),
  z.object({
    ...common,
    type: z.literal("UNBLOCK_ACCOUNT"),
    params: z.object({ account: address }),
  }),
  z.object({
    ...common,
    type: z.literal("REGISTER_VASP"),
    params: z.object({
      vaspId,
      admin: address,
      travelRuleSigner: address,
      name: z.string().trim().min(1).max(120),
      endpoint: z.url({ protocol: /^https?$/ }),
    }),
  }),
  z.object({
    ...common,
    type: z.literal("SET_VASP_STATUS"),
    params: z.object({
      vaspId,
      status: z
        .union([z.literal(1), z.literal(2), z.enum(["ACTIVE", "SUSPENDED"])])
        .transform((value) =>
          value === "ACTIVE" ? 1 : value === "SUSPENDED" ? 2 : value,
        ),
    }),
  }),
  z.object({
    ...common,
    type: z.literal("REGISTER_OPERATOR_ACCOUNT"),
    params: z.object({
      account: address,
      vaspId: z.int().min(0).max(0x7fff_ffff),
      kind: z
        .union([z.literal(3), z.literal(4), z.enum(["RELAYER", "OPERATOR"])])
        .transform((value) =>
          value === "RELAYER" ? 3 : value === "OPERATOR" ? 4 : value,
        ),
    }),
  }),
  z.object({
    ...common,
    type: z.literal("RAW"),
    params: z.object({ to: address, data: bytes }),
  }),
]);
export type ProposalInput = z.infer<typeof proposalInput>;

export function proposalCall(registry: Address, input: ProposalInput) {
  const abi = kycRegistryAbi;
  if (input.type === "RAW") return input.params;
  let data: Hex;
  switch (input.type) {
    case "BLOCK_ACCOUNT":
      data = encodeFunctionData({
        abi,
        functionName: "blockAccount",
        args: [input.params.account, input.params.reasonId],
      });
      break;
    case "UNBLOCK_ACCOUNT":
      data = encodeFunctionData({
        abi,
        functionName: "unblockAccount",
        args: [input.params.account],
      });
      break;
    case "REGISTER_VASP": {
      const { vaspId, admin, travelRuleSigner, name, endpoint } = input.params;
      data = encodeFunctionData({
        abi,
        functionName: "registerVasp",
        args: [vaspId, admin, travelRuleSigner, name, endpoint],
      });
      break;
    }
    case "SET_VASP_STATUS":
      data = encodeFunctionData({
        abi,
        functionName: "setVaspStatus",
        args: [input.params.vaspId, input.params.status],
      });
      break;
    case "REGISTER_OPERATOR_ACCOUNT":
      data = encodeFunctionData({
        abi,
        functionName: "registerOperatorAccount",
        args: [input.params.account, input.params.vaspId, input.params.kind],
      });
      break;
  }
  return { to: registry, data };
}
