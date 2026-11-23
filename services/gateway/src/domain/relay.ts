import { createHash, timingSafeEqual } from "node:crypto";
import {
  atomicSwapAbi,
  ledgerForwarderAbi,
  ledgerTokenAbi,
} from "@ledgera/abis";
import { hashForwardRequest } from "@ledgera/shared/forward-request";
import {
  type Address,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  type Hex,
  isAddress,
  maxUint256,
  recoverAddress,
} from "viem";
import { z } from "zod";
import {
  AdmissionError,
  isCanonicalS,
  type RelayOperation,
} from "./admission.ts";

const ethereumAddress = z
  .string()
  .refine((value) => isAddress(value, { strict: false }))
  .transform((value) => getAddress(value));
const uint256 = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform(BigInt)
  .refine((value) => value <= maxUint256);
const bytes = z.templateLiteral([
  "0x",
  z.string().regex(/^(?:[a-fA-F0-9]{2})*$/),
]);
const signature = z.templateLiteral([
  "0x",
  z.string().regex(/^[a-fA-F0-9]{130}$/),
]);

export const relayRequestSchema = z.object({
  requests: z
    .array(
      z.object({
        from: ethereumAddress,
        to: ethereumAddress,
        value: uint256.refine((value) => value === 0n),
        gas: uint256.refine((value) => value > 0n),
        deadline: z
          .number()
          .int()
          .min(0)
          .max(2 ** 48 - 1),
        data: bytes,
        signature,
      }),
    )
    .min(1)
    .max(4),
  submitOnRevert: z.boolean().default(false),
});

type RelayRequest = z.infer<typeof relayRequestSchema>["requests"][number];

const tokenFunctions = new Set([
  "transfer",
  "transferWithTravelRule",
  "approve",
]);

function secretHash(value: string) {
  return createHash("sha256").update(value).digest();
}

export function createRelayAuth(
  keys: Record<string, string>,
  rateLimit: number,
  now = Date.now,
) {
  const credentials = Object.entries(keys).map(([id, key]) => ({
    id: Number(id),
    digest: secretHash(key),
  }));
  const requests = new Map<number, number[]>();
  return (header: string | undefined) => {
    const bearer = header?.match(/^Bearer (\S+)$/i)?.[1];
    if (!bearer)
      throw new AdmissionError("UNAUTHORIZED", "invalid VASP API key");
    const digest = secretHash(bearer);
    let vaspId: number | undefined;
    for (const { id, digest: key } of credentials) {
      if (timingSafeEqual(key, digest)) vaspId = id;
    }
    if (vaspId === undefined)
      throw new AdmissionError("UNAUTHORIZED", "invalid VASP API key");

    const current = now();
    const recent = (requests.get(vaspId) ?? []).filter(
      (time) => time > current - 60_000,
    );
    if (recent.length >= rateLimit)
      throw new AdmissionError("RATE_LIMITED", "VASP request limit reached");
    recent.push(current);
    requests.set(vaspId, recent);
    return vaspId;
  };
}

type ForwarderChain = {
  vaspOf(sender: Address): Promise<number>;
  forwarderNonce(sender: Address): Promise<bigint>;
};

type RelayPolicy = {
  chainId: number;
  forwarder: Address;
  tokenAddresses: readonly Address[];
  swap: Address;
  gasLimit: bigint;
};

function validateTarget(request: RelayRequest, policy: RelayPolicy) {
  const isToken = policy.tokenAddresses.includes(request.to);
  if (isToken || request.to === policy.swap) {
    try {
      const { functionName } = decodeFunctionData({
        abi: isToken ? ledgerTokenAbi : atomicSwapAbi,
        data: request.data,
      });
      if (isToken ? tokenFunctions.has(functionName) : functionName === "fill")
        return;
    } catch {}
  }
  throw new AdmissionError(
    "TARGET_NOT_ALLOWED",
    "relay target or function is not allowed",
  );
}

export async function prepareForwardCall(
  policy: RelayPolicy,
  chain: ForwarderChain,
  vaspId: number,
  requests: readonly RelayRequest[],
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const domain = {
    chainId: policy.chainId,
    verifyingContract: policy.forwarder,
  };
  const requestedGas = requests.reduce(
    (total, request) => total + request.gas,
    0n,
  );
  if (requestedGas > policy.gasLimit) {
    throw new AdmissionError(
      "GAS_LIMIT_TOO_HIGH",
      "relay requests exceed gateway gas limit",
    );
  }
  const nextNonce = new Map<Address, bigint>();
  const operations: RelayOperation[] = [];
  for (const request of requests) {
    validateTarget(request, policy);
    if (request.deadline < nowSeconds || request.deadline > nowSeconds + 600) {
      throw new AdmissionError(
        "INVALID_REQUEST",
        "relay request deadline is outside the permitted window",
      );
    }

    let nonce = nextNonce.get(request.from);
    if (nonce === undefined) {
      if ((await chain.vaspOf(request.from)) !== vaspId) {
        throw new AdmissionError(
          "SIGNER_NOT_OF_VASP",
          "relay signer does not belong to the VASP",
        );
      }
      nonce = await chain.forwarderNonce(request.from);
    }
    const digest = hashForwardRequest(domain, { ...request, nonce });
    try {
      const s = `0x${request.signature.slice(66, 130)}` as const;
      const v = request.signature.slice(130).toLowerCase();
      if (!isCanonicalS(s) || (v !== "1b" && v !== "1c"))
        throw new Error("non-canonical signature");
      const recovered = await recoverAddress({
        hash: digest,
        signature: request.signature,
      });
      if (recovered !== request.from) throw new Error("unexpected signer");
    } catch {
      throw new AdmissionError(
        "INVALID_REQUEST",
        "relay signature or nonce is invalid",
      );
    }
    nextNonce.set(request.from, nonce + 1n);
    operations.push({
      from: request.from,
      to: request.to,
      selector: request.data.slice(0, 10) as Hex,
      nonce,
      digest,
    });
  }

  const data =
    requests.length === 1
      ? encodeFunctionData({
          abi: ledgerForwarderAbi,
          functionName: "execute",
          args: [requests[0]],
        })
      : encodeFunctionData({
          abi: ledgerForwarderAbi,
          functionName: "executeAll",
          args: [requests],
        });
  return { data, operations, requestedGas };
}
