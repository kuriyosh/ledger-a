import type { Deployment } from "@ledgera/config";
import { type Address, type Hex, zeroHash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { expect, test, vi } from "vitest";
import type { registryChain } from "../src/chain.ts";
import type { VaspStore } from "../src/db/store.ts";
import { transferBytes } from "../src/db/transfers.ts";
import type { TravelRuleStore } from "../src/db/travel-rules.ts";
import {
  maximumTravelRuleTtlSeconds,
  type TravelMessage,
} from "../src/travel-rule-model.ts";
import { travelRuleService } from "../src/travel-rules.ts";

const sender = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const signer = privateKeyToAccount(generatePrivateKey());
const signedAt = Math.floor(Date.now() / 1_000);
const name = { primaryIdentifier: "Test", secondaryIdentifier: "Person" };
const deployment: Deployment = {
  environment: "anvil",
  chainId: 31337,
  enforcementBlock: 1,
  auditStartBlock: 2,
  vasps: { network: 0, a: 1, b: 2 },
  contracts: {
    kycRegistry: sender,
    ledgerForwarder: sender,
    travelRuleCompliance: recipient,
    tJPY: recipient,
    tUSD: token,
    atomicSwap: recipient,
    receiptLog: recipient,
    depositProbe: recipient,
    consortiumSafe: recipient,
  },
};
const message: TravelMessage = {
  refId: zeroHash,
  originatorVaspId: 1,
  beneficiaryVaspId: 2,
  token,
  amount: "1000000",
  expiry: signedAt + 600,
  originator: {
    address: sender,
    naturalPerson: {
      name,
      dateOfBirth: "1980-01-01",
      geographicAddress: { country: "JP", addressLine: "Fixture" },
      customerIdentification: "A-000001",
    },
  },
  beneficiary: { address: recipient, naturalPerson: { name } },
};

function fixture(auto: boolean) {
  const inbox = vi.fn(
    async (
      input: TravelMessage,
      nameMatch: boolean | null,
      decision?: Parameters<TravelRuleStore["inbox"]>[2],
    ) => ({
      refId: transferBytes(input.refId),
      payload: input,
      status: decision?.status ?? "pending",
      nameMatch,
      attestation:
        decision?.status === "approved" ? decision.attestation : null,
      signature:
        decision?.status === "approved"
          ? transferBytes(decision.signature)
          : null,
    }),
  );
  const store = { inbox } as unknown as TravelRuleStore;
  const customerAt = vi.fn(async (_address: Address) => ({
    familyName: "Another",
    givenName: "Person",
    kycStatus: "approved",
  }));
  const kyc = { customerAt } as unknown as Pick<
    VaspStore,
    "customer" | "customerAt"
  >;
  const chain = {
    async recipient() {
      return { eligible: true, vaspId: 2 };
    },
    async travelEvent(_transaction: Hex) {
      return false;
    },
  };
  const registry = {} as Pick<ReturnType<typeof registryChain>, "vasp">;
  const rules = travelRuleService(
    store,
    kyc,
    registry,
    chain,
    deployment,
    2,
    signer,
    auto,
    600,
  );
  return { rules, inbox, customerAt };
}

test("rejects a different originator or excessive signed lifetime before saving", async () => {
  const { rules, inbox, customerAt } = fixture(true);
  await expect(rules.receive(3, message, signedAt)).rejects.toMatchObject({
    status: 403,
  });
  const tooFar = {
    ...message,
    expiry: signedAt + maximumTravelRuleTtlSeconds + 1,
  };
  await expect(rules.receive(1, tooFar, signedAt)).rejects.toMatchObject({
    code: "TRAVEL_RULE_EXPIRY_INVALID",
  });
  expect(customerAt).not.toHaveBeenCalled();
  expect(inbox).not.toHaveBeenCalled();
});

test("records the mismatch without disclosing it and follows the configured approval mode", async () => {
  const manual = fixture(false);
  await expect(manual.rules.receive(1, message, signedAt)).resolves.toEqual({
    refId: zeroHash,
    status: "pending",
  });
  expect(manual.inbox).toHaveBeenCalledWith(message, false, undefined);
  const demo = fixture(true);
  await expect(demo.rules.receive(1, message, signedAt)).resolves.toMatchObject(
    {
      refId: zeroHash,
      status: "approved",
      attestation: { beneficiary: recipient },
    },
  );
  expect(demo.inbox).toHaveBeenCalledWith(
    message,
    false,
    expect.objectContaining({ status: "approved" }),
  );
});
