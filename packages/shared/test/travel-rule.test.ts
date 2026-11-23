import { readFileSync } from "node:fs";
import { type Address, type Hex, recoverAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import {
  hashTravelRuleAttestation,
  signTravelRuleAttestation,
  type TravelRuleAttestation,
} from "../src/travel-rule.ts";

test("reproduces the Solidity attestation vector with viem", async () => {
  const raw = JSON.parse(
    readFileSync(new URL("vectors/attestation.json", import.meta.url), "utf8"),
  ) as {
    domain: { chainId: number; verifyingContract: Address };
    message: Omit<TravelRuleAttestation, "amount" | "expiry"> & {
      amount: string;
      expiry: string;
    };
    signer: Address;
    hash: Hex;
    signature: Hex;
  };
  const attestation = {
    ...raw.message,
    amount: BigInt(raw.message.amount),
    expiry: BigInt(raw.message.expiry),
  };
  const signer = privateKeyToAccount(toHex(2, { size: 32 }));
  const hash = hashTravelRuleAttestation(raw.domain, attestation);
  const signature = await signTravelRuleAttestation(
    signer,
    raw.domain,
    attestation,
  );

  expect(hash).toBe(raw.hash);
  expect(signature).toBe(raw.signature);
  expect(await recoverAddress({ hash, signature })).toBe(raw.signer);
  expect(
    hashTravelRuleAttestation({ ...raw.domain, chainId: 1 }, attestation),
  ).not.toBe(hash);
});
