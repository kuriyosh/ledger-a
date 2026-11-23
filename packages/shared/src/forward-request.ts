import { type Address, type Hex, hashTypedData, type LocalAccount } from "viem";

export const forwardRequestTypes = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
} as const;

export type ForwardRequest = {
  from: Address;
  to: Address;
  value: bigint;
  gas: bigint;
  nonce: bigint;
  deadline: number;
  data: Hex;
};

type ForwarderDomain = { chainId: number; verifyingContract: Address };

function forwardRequestData(domain: ForwarderDomain, message: ForwardRequest) {
  return {
    domain: { ...domain, name: "ledgerA Forwarder", version: "1" },
    types: forwardRequestTypes,
    primaryType: "ForwardRequest",
    message,
  } as const;
}

export function hashForwardRequest(
  domain: ForwarderDomain,
  message: ForwardRequest,
) {
  return hashTypedData(forwardRequestData(domain, message));
}

export function signForwardRequest(
  signer: LocalAccount,
  domain: ForwarderDomain,
  message: ForwardRequest,
) {
  return signer.signTypedData(forwardRequestData(domain, message));
}
