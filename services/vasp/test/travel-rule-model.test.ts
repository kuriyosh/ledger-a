import { zeroHash } from "viem";
import { expect, test } from "vitest";
import {
  namesMatch,
  proofOf,
  proofTyped,
  travelMessage,
} from "../src/travel-rule-model.ts";

const sender = "0x1111111111111111111111111111111111111111";
const receiver = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const name = { primaryIdentifier: "山田", secondaryIdentifier: "太郎" };
const fixture = {
  refId: zeroHash,
  originatorVaspId: 1,
  beneficiaryVaspId: 2,
  token,
  amount: "1200000",
  expiry: 1_800_000_000,
  originator: {
    address: sender,
    naturalPerson: {
      name,
      dateOfBirth: "1980-01-01",
      geographicAddress: { country: "JP", addressLine: "fixture" },
      customerIdentification: "A-000001",
    },
  },
  beneficiary: { address: receiver, naturalPerson: { name } },
};

test("rejects invalid amounts without converting malformed strings to BigInt", () => {
  for (const amount of ["word", "-1", "0", "01", (1n << 256n).toString()])
    expect(travelMessage.safeParse({ ...fixture, amount }).success).toBe(false);
});

test("keeps identifying fields out of the attestation and normalizes names for comparison", () => {
  expect(proofTyped(proofOf(travelMessage.parse(fixture)))).toEqual({
    refId: zeroHash,
    originator: sender,
    beneficiary: receiver,
    token,
    amount: 1_200_000n,
    originatorVaspId: 1,
    beneficiaryVaspId: 2,
    expiry: 1_800_000_000n,
  });
  expect(
    namesMatch(
      { primaryIdentifier: " Éclair ", secondaryIdentifier: "Marie" },
      { primaryIdentifier: "e\u0301clair", secondaryIdentifier: "marie" },
    ),
  ).toBe(true);
});
