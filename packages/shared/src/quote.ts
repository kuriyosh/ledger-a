import { type Address, hashTypedData, type LocalAccount } from "viem";

export const quoteTypes = {
  Quote: [
    { name: "maker", type: "address" },
    { name: "taker", type: "address" },
    { name: "makerToken", type: "address" },
    { name: "takerToken", type: "address" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export type Quote = {
  maker: Address;
  taker: Address;
  makerToken: Address;
  takerToken: Address;
  makerAmount: bigint;
  takerAmount: bigint;
  expiry: bigint;
  nonce: bigint;
};

type SwapDomain = { chainId: number; verifyingContract: Address };

function quoteData(domain: SwapDomain, message: Quote) {
  return {
    domain: { ...domain, name: "ledgerA AtomicSwap", version: "1" },
    types: quoteTypes,
    primaryType: "Quote",
    message,
  } as const;
}

export function hashQuote(domain: SwapDomain, message: Quote) {
  return hashTypedData(quoteData(domain, message));
}

export function signQuote(
  signer: LocalAccount,
  domain: SwapDomain,
  message: Quote,
) {
  return signer.signTypedData(quoteData(domain, message));
}
