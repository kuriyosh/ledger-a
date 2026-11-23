import { kycRegistryAbi } from "@ledgera/abis";
import { type Deployment, defineLedgerChain } from "@ledgera/config";
import { type Address, createPublicClient, http } from "viem";
import type { AdmissionChain } from "../domain/admission.ts";

export function connectSequencer(deployment: Deployment, rpcUrl: string) {
  const chain = defineLedgerChain(deployment.environment, {
    rpcUrl,
    devnetChainId: deployment.chainId,
  });
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 5_000, retryCount: 0 }),
  });
}

export type SequencerClient = ReturnType<typeof connectSequencer>;

export function admissionChain(
  client: SequencerClient,
  registry: Address,
): AdmissionChain {
  return {
    async senderState(sender) {
      const [block, nonce, balance] = await Promise.all([
        client.getBlock({ blockTag: "latest" }),
        client.getTransactionCount({ address: sender, blockTag: "pending" }),
        client.getBalance({ address: sender, blockTag: "pending" }),
      ]);
      const enforcement = await client.readContract({
        address: registry,
        abi: kycRegistryAbi,
        functionName: "enforcementEnabled",
        blockHash: block.hash,
        requireCanonical: true,
      });
      const eligible =
        !enforcement ||
        (await client.readContract({
          address: registry,
          abi: kycRegistryAbi,
          functionName: "isActive",
          args: [sender],
          blockHash: block.hash,
          requireCanonical: true,
        }));
      return {
        eligible,
        nonce: BigInt(nonce),
        balance,
        baseFee: block.baseFeePerGas ?? 0n,
      };
    },
  };
}
