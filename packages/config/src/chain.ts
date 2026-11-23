import { defineChain } from "viem";
import {
  ANVIL_CHAIN_ID,
  DEFAULT_DEVNET_CHAIN_ID,
  devnetChainIdSchema,
} from "./env.ts";

export type ChainMode = "anvil" | "devnet" | "devnet-ha";

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
    name: mode === "anvil" ? "ledgerA Anvil" : "ledgerA DevNet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    testnet: true,
  });
}
