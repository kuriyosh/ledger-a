import { randomBytes } from "node:crypto";
import type { Deployment } from "@ledgera/config";
import { ServiceError } from "@ledgera/shared/errors";
import {
  signHttpRequestWithDigest,
  signHttpResponse,
  verifyHttpResponse,
} from "@ledgera/shared/http-signature";
import {
  hashTravelRuleAttestation,
  signTravelRuleAttestation,
} from "@ledgera/shared/travel-rule";
import {
  type Address,
  bytesToHex,
  getAddress,
  type Hex,
  type LocalAccount,
  recoverAddress,
} from "viem";
import type { registryChain } from "./chain.ts";
import type { VaspStore } from "./db/store.ts";
import type { Transfer } from "./db/transfers.ts";
import { peerView, type TravelRuleStore } from "./db/travel-rules.ts";
import type { transferChain } from "./transfer-chain.ts";
import {
  maximumTravelRuleTtlSeconds,
  namesMatch,
  type PeerReply,
  peerReply,
  proofOf,
  proofTyped,
  type TravelMessage,
} from "./travel-rule-model.ts";

const root = "/vasp/v1/travel-rule/transfers";
const now = () => Math.floor(Date.now() / 1000);
const halfOrder =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function denied() {
  return new ServiceError(
    "TRAVEL_RULE_PARTY_MISMATCH",
    "Travel Rule participants do not match",
    403,
  );
}

function pending() {
  return new ServiceError(
    "TRAVEL_RULE_NOT_INCLUDED",
    "Travel Rule transfer is not included",
    409,
  );
}

export function travelRuleService(
  store: TravelRuleStore,
  customers: Pick<VaspStore, "customer" | "customerAt">,
  registry: Pick<ReturnType<typeof registryChain>, "vasp">,
  chain: Pick<ReturnType<typeof transferChain>, "recipient" | "travelEvent">,
  deployment: Deployment,
  ownId: number,
  signer: LocalAccount,
  autoApprove: boolean,
  ttl: number,
  requestHttp = fetch,
) {
  const domain = {
    chainId: deployment.chainId,
    verifyingContract: deployment.contracts.travelRuleCompliance,
  };
  const confirmationBatchSize = 20;
  let confirmationCursor: Buffer | undefined;
  const tokens = [deployment.contracts.tJPY, deployment.contracts.tUSD].map(
    (address) => address.toLowerCase(),
  );

  async function proof(message: TravelMessage) {
    const attestation = proofOf(message);
    return {
      status: "approved" as const,
      attestation,
      signature: await signTravelRuleAttestation(
        signer,
        domain,
        proofTyped(attestation),
      ),
    };
  }

  async function approved(
    message: TravelMessage,
    reply: Extract<PeerReply, { status: "approved" }>,
    peer: Address,
  ) {
    const expected = hashTravelRuleAttestation(
      domain,
      proofTyped(proofOf(message)),
    );
    const received = hashTravelRuleAttestation(
      domain,
      proofTyped(reply.attestation),
    );
    if (
      expected !== received ||
      !["1b", "1c"].includes(reply.signature.slice(130)) ||
      BigInt(`0x${reply.signature.slice(66, 130)}`) > halfOrder
    )
      return false;
    try {
      return (
        (
          await recoverAddress({ hash: received, signature: reply.signature })
        ).toLowerCase() === peer.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  async function transmit(endpoint: string, path: string, body?: object) {
    try {
      const url = new URL(path, endpoint);
      const request = new Request(url, {
        method: body ? "POST" : "GET",
        body: body && JSON.stringify(body),
        headers: body ? { "Content-Type": "application/json" } : {},
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      const { headers, digest } = await signHttpRequestWithDigest(
        signer,
        request,
        ownId,
      );
      for (const [key, value] of Object.entries(headers))
        request.headers.set(key, value);
      const response = await requestHttp(request);
      if (response.ok) return { response, digest };
    } catch {
      return undefined;
    }
  }

  async function eligible(address: Address) {
    const customer = await customers.customerAt(address);
    if (customer?.kycStatus !== "approved") return undefined;
    const holder = await chain.recipient(address);
    return holder.eligible && holder.vaspId === ownId ? customer : undefined;
  }

  function current(
    row: Awaited<ReturnType<TravelRuleStore["message"]>>,
  ): PeerReply {
    return row.payload.expiry <= now()
      ? { refId: bytesToHex(row.refId), status: "rejected" }
      : peerView(row);
  }

  return {
    async resolveVasp(id: number) {
      const vasp = await registry.vasp(id);
      return { active: vasp.status === 1, signer: vasp.travelRuleSigner };
    },
    responseHeaders(requestDigest: Hex, status: number, body: string) {
      return signHttpResponse(
        signer,
        ownId,
        requestDigest,
        status,
        new TextEncoder().encode(body),
      );
    },
    async receive(peer: number, message: TravelMessage, signedAt: number) {
      if (
        peer === ownId ||
        message.originatorVaspId !== peer ||
        message.beneficiaryVaspId !== ownId
      )
        throw denied();
      if (!tokens.includes(message.token.toLowerCase()))
        throw new ServiceError(
          "TRAVEL_RULE_TOKEN_INVALID",
          "Unsupported token",
          400,
        );
      if (message.expiry > signedAt + maximumTravelRuleTtlSeconds)
        throw new ServiceError(
          "TRAVEL_RULE_EXPIRY_INVALID",
          "Travel Rule expiry is too far in the future",
          400,
        );
      if (message.expiry <= now())
        return current(await store.inbox(message, null, { status: "expired" }));
      const customer = await eligible(message.beneficiary.address);
      if (!customer)
        return peerView(
          await store.inbox(message, null, { status: "rejected" }),
        );
      const match = namesMatch(message.beneficiary.naturalPerson.name, {
        primaryIdentifier: customer.familyName,
        secondaryIdentifier: customer.givenName,
      });
      const decision = autoApprove ? await proof(message) : undefined;
      return current(await store.inbox(message, match, decision));
    },
    async get(peer: number, refId: Hex) {
      return current(await store.message(refId, "in", peer));
    },
    async confirm(peer: number, refId: Hex, hash: Hex) {
      const row = await store.message(refId, "in", peer);
      if (
        row.status !== "approved" ||
        !(await store.hasIncoming(refId, hash)) ||
        !(await chain.travelEvent(hash, proofOf(row.payload)))
      )
        throw pending();
      await store.recordHash(refId, "in", hash);
    },
    async decide(refId: Hex, action: "approve" | "reject") {
      const row = await store.message(refId, "in");
      if (row.status !== "pending") {
        const status = action === "approve" ? "approved" : "rejected";
        if (row.status !== status)
          throw new ServiceError(
            "TRAVEL_RULE_ALREADY_DECIDED",
            "Travel Rule message already has a decision",
            409,
          );
        return current(row);
      }
      if (row.payload.expiry <= now())
        return peerView(await store.decide(refId, { status: "expired" }));
      if (
        action === "reject" ||
        !(await eligible(row.payload.beneficiary.address))
      )
        return peerView(await store.decide(refId, { status: "rejected" }));
      return current(await store.decide(refId, await proof(row.payload)));
    },
    list(direction?: "in" | "out") {
      return store.listing(direction);
    },
    async begin(row: Transfer, beneficiaryVaspId: number) {
      const customer = await customers.customer(row.customerId);
      if (!customer.address || !row.beneficiaryName)
        throw new Error("Travel Rule transfer has no required parties");
      const message: TravelMessage = {
        refId: bytesToHex(randomBytes(32)),
        originatorVaspId: ownId,
        beneficiaryVaspId,
        token: getAddress(bytesToHex(row.token)),
        amount: row.amount.toString(),
        expiry: now() + ttl,
        originator: {
          address: customer.address,
          naturalPerson: {
            name: {
              primaryIdentifier: customer.familyName,
              secondaryIdentifier: customer.givenName,
            },
            dateOfBirth: customer.dateOfBirth,
            geographicAddress: {
              country: customer.country,
              addressLine: customer.addressLine,
            },
            customerIdentification: customer.id,
          },
        },
        beneficiary: {
          address: getAddress(bytesToHex(row.counterpartyAddress)),
          naturalPerson: { name: row.beneficiaryName },
        },
      };
      await store.begin(row, message);
    },
    async advance(row: Transfer) {
      if (!row.refId) throw new Error("Travel Rule transfer has no reference");
      const refId = bytesToHex(row.refId);
      const stored = await store.message(refId, "out");
      if (stored.payload.expiry <= now()) {
        await store.advance(row, refId, { status: "expired" });
        return;
      }
      const peer = await registry.vasp(stored.counterpartyVaspId);
      if (peer.status !== 1) return;
      const exchange = stored.deliveredAt
        ? await transmit(peer.endpoint, `${root}/${refId}`)
        : await transmit(peer.endpoint, root, stored.payload);
      if (exchange?.response.status !== 200) return;
      const body = await verifyHttpResponse(
        exchange.response,
        exchange.digest,
        {
          vaspId: stored.counterpartyVaspId,
          signer: peer.travelRuleSigner,
        },
      );
      const result = peerReply.safeParse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      );
      if (!result.success || result.data.refId !== refId) return;
      if (stored.payload.expiry <= now()) {
        await store.advance(row, refId, { status: "expired" });
        return;
      }
      if (result.data.status === "pending") await store.advance(row, refId);
      if (result.data.status === "rejected")
        await store.advance(row, refId, { status: "rejected" });
      if (
        result.data.status === "approved" &&
        (await approved(stored.payload, result.data, peer.travelRuleSigner))
      )
        await store.advance(row, refId, result.data);
    },
    async approval(row: Transfer) {
      if (!row.refId)
        throw new Error("Approved transfer has no Travel Rule reference");
      const refId = bytesToHex(row.refId);
      const entry = await store.message(refId, "out");
      if (entry.payload.expiry <= now()) {
        await store.advance(row, refId, { status: "expired" });
        return;
      }
      if (!entry.attestation || !entry.signature)
        throw new Error("Approved Travel Rule message has no signature");
      return {
        attestation: proofTyped(entry.attestation),
        signature: bytesToHex(entry.signature),
      };
    },
    async report() {
      await store.expireInbox(now());
      const items = await store.unreported(
        confirmationCursor,
        confirmationBatchSize,
      );
      confirmationCursor =
        items.length === confirmationBatchSize
          ? items.at(-1)?.refId
          : undefined;
      for (const row of items) {
        if (!row.hash) continue;
        const refId = bytesToHex(row.refId);
        const hash = bytesToHex(row.hash);
        const peer = await registry.vasp(row.peer);
        if (peer.status !== 1) continue;
        const exchange = await transmit(
          peer.endpoint,
          `${root}/${refId}/confirm`,
          { txHash: hash },
        );
        if (exchange?.response.status !== 204) continue;
        try {
          await verifyHttpResponse(exchange.response, exchange.digest, {
            vaspId: row.peer,
            signer: peer.travelRuleSigner,
          });
          await store.recordHash(refId, "out", hash);
        } catch {}
      }
    },
  };
}
