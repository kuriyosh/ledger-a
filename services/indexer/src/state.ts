import { kycRegistryAbi, ledgerTokenAbi } from "@ledgera/abis";
import type { Deployment } from "@ledgera/config";
import { type Address, createPublicClient, type Hex, http } from "viem";

export function chainState(
  url: string,
  contracts: Deployment["contracts"],
  fetchFn = fetch,
) {
  const client = createPublicClient({
    transport: http(url, { retryCount: 0, timeout: 5_000, fetchFn }),
  });
  return {
    async balance(token: Address, account: Address, blockHash: Hex) {
      const options = { address: token, blockHash, requireCanonical: true };
      const code = await client.getCode({
        address: options.address,
        blockHash,
        requireCanonical: true,
      });
      if (code === undefined || code === "0x") return 0n;
      return client.readContract({
        ...options,
        abi: ledgerTokenAbi,
        functionName: "balanceOf",
        args: [account],
      });
    },
    async registry(blockHash: Hex) {
      const options = {
        address: contracts.kycRegistry,
        blockHash,
        requireCanonical: true,
      };
      const code = await client.getCode({
        address: options.address,
        blockHash,
        requireCanonical: true,
      });
      if (code === undefined || code === "0x")
        return { enforcementEnabled: false, registryVersion: 0n };
      const [enforcementEnabled, registryVersion] = await Promise.all([
        client.readContract({
          ...options,
          abi: kycRegistryAbi,
          functionName: "enforcementEnabled",
        }),
        client.readContract({
          ...options,
          abi: kycRegistryAbi,
          functionName: "version",
        }),
      ]);
      return { enforcementEnabled, registryVersion };
    },
  };
}
