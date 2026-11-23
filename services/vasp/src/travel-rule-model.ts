import type { TravelRuleAttestation } from "@ledgera/shared/travel-rule";
import { type Address, getAddress, type Hex, isAddress } from "viem";
import { z } from "zod";

const checkedAddress = z
  .string()
  .refine((value) => isAddress(value, { strict: false }))
  .transform((value) => getAddress(value.toLowerCase()));
export const refIdInput = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
const signatureInput = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/)
  .transform((value) => value.toLowerCase() as Hex);
const vaspId = z.int().min(1).max(0x7fff_ffff);
const maximumAmount = (1n << 256n) - 1n;
const amount = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .pipe(z.string().refine((value) => BigInt(value) <= maximumAmount));
const namePart = z.string().trim().min(1).max(200);
const name = z.object({
  primaryIdentifier: namePart,
  secondaryIdentifier: namePart,
});
const expiry = z.int().positive();

export const travelMessage = z.object({
  refId: refIdInput,
  originatorVaspId: vaspId,
  beneficiaryVaspId: vaspId,
  token: checkedAddress,
  amount,
  expiry,
  originator: z.object({
    address: checkedAddress,
    naturalPerson: z.object({
      name,
      dateOfBirth: z.iso.date(),
      geographicAddress: z.object({
        country: z.string().regex(/^[A-Z]{2}$/),
        addressLine: z.string().trim().min(1).max(500),
      }),
      customerIdentification: z.string().min(1).max(64),
    }),
  }),
  beneficiary: z.object({
    address: checkedAddress,
    naturalPerson: z.object({ name }),
  }),
});

export const attestationInput = z.object({
  refId: refIdInput,
  originator: checkedAddress,
  beneficiary: checkedAddress,
  token: checkedAddress,
  amount,
  originatorVaspId: vaspId,
  beneficiaryVaspId: vaspId,
  expiry,
});

export const peerReply = z.discriminatedUnion("status", [
  z.object({ refId: refIdInput, status: z.literal("pending") }),
  z.object({ refId: refIdInput, status: z.literal("rejected") }),
  z.object({
    refId: refIdInput,
    status: z.literal("approved"),
    attestation: attestationInput,
    signature: signatureInput,
  }),
]);
export const confirmInput = z.object({ txHash: refIdInput });
export type TravelMessage = z.infer<typeof travelMessage>;
export type AttestationWire = z.infer<typeof attestationInput>;
export type TravelName = z.infer<typeof name>;
export type PeerReply = z.infer<typeof peerReply>;

export function proofOf(message: TravelMessage): AttestationWire {
  const { refId, originatorVaspId, beneficiaryVaspId, token, amount, expiry } =
    message;
  return {
    refId,
    originatorVaspId,
    beneficiaryVaspId,
    token,
    amount,
    expiry,
    originator: message.originator.address,
    beneficiary: message.beneficiary.address,
  };
}

export function proofTyped(
  attestation: AttestationWire,
): TravelRuleAttestation {
  return {
    ...attestation,
    amount: BigInt(attestation.amount),
    expiry: BigInt(attestation.expiry),
  };
}

export function namesMatch(a: TravelName, b: TravelName) {
  const normalize = (value: string) =>
    value.trim().normalize("NFC").toLowerCase();
  return (
    normalize(a.primaryIdentifier) === normalize(b.primaryIdentifier) &&
    normalize(a.secondaryIdentifier) === normalize(b.secondaryIdentifier)
  );
}

export type TravelRecipient = { address: Address; name: TravelName };
