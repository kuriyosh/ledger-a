import {
  type Address,
  type Hex,
  hashMessage,
  keccak256,
  type LocalAccount,
  recoverAddress,
} from "viem";
import { ServiceError } from "./errors.ts";

const headers = {
  vaspId: "X-Ledgera-Vasp-Id",
  timestamp: "X-Ledgera-Timestamp",
  signature: "X-Ledgera-Signature",
} as const;
const maxClockSkewSeconds = 300;
const halfCurveOrder =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

type ResolveVasp = (
  vaspId: number,
) => Promise<{ active: boolean; signer: Address } | undefined>;

function numberHeader(value: string | null, max: number) {
  if (value === null || !/^(0|[1-9][0-9]{0,15})$/.test(value)) return;
  const parsed = Number(value);
  return parsed <= max ? parsed : undefined;
}

function unixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function signingMessage(
  request: Request,
  url: URL,
  timestamp: number,
  body: Uint8Array,
) {
  return [
    request.method.toUpperCase(),
    url.pathname,
    timestamp,
    keccak256(body),
  ].join("\n");
}

function canonicalSignature(value: string | null): value is Hex {
  if (!value || !/^0x[0-9a-f]{128}(1b|1c)$/.test(value)) return false;
  const s = BigInt(`0x${value.slice(66, 130)}`);
  return s > 0n && s <= halfCurveOrder;
}

function validateSigningContext(vaspId: number, timestamp: number) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new RangeError("Expected a UNIX timestamp in seconds");
  if (!Number.isInteger(vaspId) || vaspId < 1 || vaspId > 0xffff_ffff)
    throw new RangeError("Expected a positive uint32 VASP ID");
}

async function signHeaders(
  signer: LocalAccount,
  vaspId: number,
  timestamp: number,
  message: string,
) {
  const signature = await signer.signMessage({ message });
  return {
    [headers.vaspId]: vaspId.toString(),
    [headers.timestamp]: timestamp.toString(),
    [headers.signature]: signature.toLowerCase() as Hex,
  };
}

export async function signHttpRequest(
  signer: LocalAccount,
  request: Request,
  vaspId: number,
  timestamp = unixSeconds(),
) {
  return (await signHttpRequestWithDigest(signer, request, vaspId, timestamp))
    .headers;
}

export async function signHttpRequestWithDigest(
  signer: LocalAccount,
  request: Request,
  vaspId: number,
  timestamp = unixSeconds(),
) {
  validateSigningContext(vaspId, timestamp);
  const url = new URL(request.url);
  if (url.search)
    throw new TypeError("Signed VASP requests cannot have a query");
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const message = signingMessage(request, url, timestamp, body);
  return {
    headers: await signHeaders(signer, vaspId, timestamp, message),
    digest: hashMessage(message),
  };
}

function invalidSignature() {
  return new ServiceError(
    "INVALID_VASP_SIGNATURE",
    "VASP signature is missing, invalid, or expired",
    401,
  );
}

function signatureFields(fields: Headers, now: number) {
  const vaspId = numberHeader(fields.get(headers.vaspId), 0xffff_ffff);
  const timestamp = numberHeader(
    fields.get(headers.timestamp),
    Number.MAX_SAFE_INTEGER,
  );
  const signature = fields.get(headers.signature);
  if (
    !vaspId ||
    timestamp === undefined ||
    Math.abs(now - timestamp) > maxClockSkewSeconds ||
    !canonicalSignature(signature)
  )
    throw invalidSignature();
  return { vaspId, timestamp, signature };
}

async function recoverSigner(digest: Hex, signature: Hex) {
  try {
    return await recoverAddress({ hash: digest, signature });
  } catch {
    throw invalidSignature();
  }
}

export async function verifyHttpRequest(
  request: Request,
  resolveVasp: ResolveVasp,
  now = unixSeconds(),
) {
  const { vaspId, timestamp, signature } = signatureFields(
    request.headers,
    now,
  );
  const url = new URL(request.url);
  if (url.search) throw invalidSignature();
  const body = new Uint8Array(await request.arrayBuffer());
  const digest = hashMessage(signingMessage(request, url, timestamp, body));
  const recovered = await recoverSigner(digest, signature);
  const vasp = await resolveVasp(vaspId);
  if (!vasp?.active || vasp.signer.toLowerCase() !== recovered.toLowerCase())
    throw invalidSignature();
  return { vaspId, timestamp, signer: recovered, digest, body };
}

function responseMessage(
  requestDigest: Hex,
  status: number,
  timestamp: number,
  body: Uint8Array,
) {
  return [
    "ledgerA-http-response-v1",
    requestDigest,
    status,
    timestamp,
    keccak256(body),
  ].join("\n");
}

export function signHttpResponse(
  signer: LocalAccount,
  vaspId: number,
  requestDigest: Hex,
  status: number,
  body: Uint8Array,
  timestamp = unixSeconds(),
) {
  validateSigningContext(vaspId, timestamp);
  return signHeaders(
    signer,
    vaspId,
    timestamp,
    responseMessage(requestDigest, status, timestamp, body),
  );
}

export async function verifyHttpResponse(
  response: Response,
  requestDigest: Hex,
  peer: { vaspId: number; signer: Address },
  now = unixSeconds(),
) {
  const { vaspId, timestamp, signature } = signatureFields(
    response.headers,
    now,
  );
  if (vaspId !== peer.vaspId) throw invalidSignature();
  const body = new Uint8Array(await response.arrayBuffer());
  const digest = hashMessage(
    responseMessage(requestDigest, response.status, timestamp, body),
  );
  if (
    (await recoverSigner(digest, signature)).toLowerCase() !==
    peer.signer.toLowerCase()
  )
    throw invalidSignature();
  return body;
}
