import { defineChain } from "viem";
import {
  ANVIL_CHAIN_ID,
  DEFAULT_DEVNET_CHAIN_ID,
  devnetChainIdSchema,
} from "./env.ts";

export type ChainMode = "anvil" | "devnet" | "devnet-ha";

const chainNames: Record<ChainMode, string> = {
  anvil: "ledgerA Anvil",
  devnet: "ledgerA DevNet",
  "devnet-ha": "ledgerA DevNet HA",
};

export function defineLedgerChain(
  mode: ChainMode,
  {
    rpcUrl = "http://127.0.0.1:8545",
    devnetChainId = DEFAULT_DEVNET_CHAIN_ID,
  }: { rpcUrl?: string; devnetChainId?: number } = {},
) {
  return defineChain({
    id:
      mode === "anvil"
        ? ANVIL_CHAIN_ID
        : devnetChainIdSchema.parse(devnetChainId),
    name: chainNames[mode],
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    testnet: true,
  });
}
