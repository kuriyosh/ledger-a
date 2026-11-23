import { writeFileSync } from "node:fs";
import { toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  hashTravelRuleAttestation,
  signTravelRuleAttestation,
  type TravelRuleAttestation,
} from "../src/travel-rule.ts";

const signer = privateKeyToAccount(toHex(2, { size: 32 }));
const domain = {
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000001200",
} as const;
const message: TravelRuleAttestation = {
  refId: toHex(100, { size: 32 }),
  originator: "0x0000000000000000000000000000000000001101",
  beneficiary: "0x0000000000000000000000000000000000001102",
  token: "0x0000000000000000000000000000000000001103",
  amount: 23_456_789n,
  originatorVaspId: 1,
  beneficiaryVaspId: 2,
  expiry: 1_800_000_000n,
};

const vector = {
  domain,
  message: {
    ...message,
    amount: message.amount.toString(),
    expiry: message.expiry.toString(),
  },
  signer: signer.address,
  hash: hashTravelRuleAttestation(domain, message),
  signature: await signTravelRuleAttestation(signer, domain, message),
};

writeFileSync(
  new URL("vectors/attestation.json", import.meta.url),
  `${JSON.stringify(vector, null, 2)}\n`,
);
