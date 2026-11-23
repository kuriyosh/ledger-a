import { type Address, type Hex, hashTypedData, type LocalAccount } from "viem";

export const travelRuleTypes = {
  TravelRuleAttestation: [
    { name: "refId", type: "bytes32" },
    { name: "originator", type: "address" },
    { name: "beneficiary", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "originatorVaspId", type: "uint32" },
    { name: "beneficiaryVaspId", type: "uint32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export type TravelRuleAttestation = {
  refId: Hex;
  originator: Address;
  beneficiary: Address;
  token: Address;
  amount: bigint;
  originatorVaspId: number;
  beneficiaryVaspId: number;
  expiry: bigint;
};

type TravelRuleDomain = { chainId: number; verifyingContract: Address };

function attestationData(
  domain: TravelRuleDomain,
  message: TravelRuleAttestation,
) {
  return {
    domain: { ...domain, name: "ledgerA TravelRule", version: "1" },
    types: travelRuleTypes,
    primaryType: "TravelRuleAttestation",
    message,
  } as const;
}

export function hashTravelRuleAttestation(
  domain: TravelRuleDomain,
  message: TravelRuleAttestation,
) {
  return hashTypedData(attestationData(domain, message));
}

export function signTravelRuleAttestation(
  signer: LocalAccount,
  domain: TravelRuleDomain,
  message: TravelRuleAttestation,
) {
  return signer.signTypedData(attestationData(domain, message));
}
