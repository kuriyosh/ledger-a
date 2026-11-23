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

export async function signHttpRequest(
  signer: LocalAccount,
  request: Request,
  vaspId: number,
  timestamp = unixSeconds(),
) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError("Expected a UNIX timestamp in seconds");
  }
  if (!Number.isInteger(vaspId) || vaspId < 1 || vaspId > 0xffff_ffff) {
    throw new RangeError("Expected a positive uint32 VASP ID");
  }
  const url = new URL(request.url);
  if (url.search)
    throw new TypeError("Signed VASP requests cannot have a query");
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const signature = await signer.signMessage({
    message: signingMessage(request, url, timestamp, body),
  });
  return {
    [headers.vaspId]: vaspId.toString(),
    [headers.timestamp]: timestamp.toString(),
    [headers.signature]: signature.toLowerCase() as Hex,
  };
}

export async function verifyHttpRequest(
  request: Request,
  resolveVasp: ResolveVasp,
  now = unixSeconds(),
) {
  const vaspId = numberHeader(request.headers.get(headers.vaspId), 0xffff_ffff);
  const timestamp = numberHeader(
    request.headers.get(headers.timestamp),
    Number.MAX_SAFE_INTEGER,
  );
  const signature = request.headers.get(headers.signature);
  const url = new URL(request.url);
  const unauthorized = () =>
    new ServiceError(
      "INVALID_VASP_SIGNATURE",
      "VASP signature is missing, invalid, or expired",
      401,
    );
  if (
    vaspId === undefined ||
    vaspId === 0 ||
    url.search ||
    timestamp === undefined ||
    Math.abs(now - timestamp) > maxClockSkewSeconds ||
    !canonicalSignature(signature)
  )
    throw unauthorized();
  const body = new Uint8Array(await request.arrayBuffer());
  const digest = hashMessage(signingMessage(request, url, timestamp, body));
  let recovered: Address;
  try {
    recovered = await recoverAddress({ hash: digest, signature });
  } catch {
    throw unauthorized();
  }
  const vasp = await resolveVasp(vaspId);
  if (!vasp?.active || vasp.signer.toLowerCase() !== recovered.toLowerCase()) {
    throw unauthorized();
  }
  return { vaspId, timestamp, signer: recovered, digest, body };
}
