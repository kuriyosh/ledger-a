import { kycRegistryAbi } from "@ledgera/abis";
import { type Deployment, defineLedgerChain } from "@ledgera/config";
import { type Address, createPublicClient, custom, http } from "viem";
import type { AdmissionChain } from "../domain/admission.ts";

export function connectSequencer(
  deployment: Deployment,
  rpcUrl: string,
  select?: (method: string) => Promise<string>,
) {
  const chain = defineLedgerChain(deployment.environment, {
    rpcUrl,
    devnetChainId: deployment.chainId,
  });
  return createPublicClient({
    chain,
    transport: custom(
      {
        async request(input) {
          const target = select ? await select(input.method) : rpcUrl;
          return http(target, { timeout: 5_000, retryCount: 0 })({
            chain,
          }).request(input);
        },
      },
      { retryCount: 0 },
    ),
  });
}

export type SequencerClient = ReturnType<typeof connectSequencer>;

export function admissionChain(
  client: SequencerClient,
  registry: Address,
): AdmissionChain {
  return {
    async senderState(sender) {
      const block = await client.getBlock({ blockTag: "latest" });
      const canonical = {
        blockHash: block.hash,
        requireCanonical: true,
      } as const;
      const [nonce, confirmedNonce, balance, enforcement] = await Promise.all([
        client.getTransactionCount({ address: sender, blockTag: "pending" }),
        client.getTransactionCount({ address: sender, ...canonical }),
        client.getBalance({ address: sender, ...canonical }),
        client.readContract({
          address: registry,
          abi: kycRegistryAbi,
          functionName: "enforcementEnabled",
          ...canonical,
        }),
      ]);
      const eligible =
        !enforcement ||
        (await client.readContract({
          address: registry,
          abi: kycRegistryAbi,
          functionName: "isActive",
          args: [sender],
          ...canonical,
        }));
      return {
        eligible,
        nonce: BigInt(nonce),
        confirmedNonce: BigInt(confirmedNonce),
        balance,
        baseFee: block.baseFeePerGas ?? 0n,
      };
    },
  };
}
