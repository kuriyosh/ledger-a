import {
  type Address,
  type Hex,
  keccak256,
  type LocalAccount,
  recoverMessageAddress,
  stringToBytes,
} from "viem";
import { ServiceError } from "./errors.ts";

const headers = {
  vaspId: "X-Ledgera-Vasp-Id",
  timestamp: "X-Ledgera-Timestamp",
  signature: "X-Ledgera-Signature",
} as const;
const maxClockSkewSeconds = 300;

type RequestPayload = {
  method: string;
  path: string;
  body: Uint8Array | string;
};

type ResolveVasp = (
  vaspId: number,
) => Promise<{ active: boolean; signer: Address } | undefined>;

function numberHeader(value: string | null, max: number) {
  if (value === null || !/^(0|[1-9][0-9]{0,15})$/.test(value)) return;
  const parsed = Number(value);
  return parsed <= max ? parsed : undefined;
}

function message(payload: RequestPayload, timestamp: number) {
  const method = payload.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method) || !/^\/[^\r\n?#]*$/.test(payload.path)) {
    throw new TypeError(
      "Expected an HTTP method and absolute path without a query",
    );
  }
  const body =
    typeof payload.body === "string"
      ? stringToBytes(payload.body)
      : payload.body;
  return [method, payload.path, timestamp, keccak256(body)].join("\n");
}

function unixSeconds() {
  return Math.floor(Date.now() / 1000);
}

export async function signHttpRequest(
  signer: LocalAccount,
  payload: RequestPayload,
  vaspId: number,
  timestamp = unixSeconds(),
) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError("Expected a UNIX timestamp in seconds");
  }
  if (!Number.isInteger(vaspId) || vaspId < 1 || vaspId > 0xffff_ffff) {
    throw new RangeError("Expected a positive uint32 VASP ID");
  }
  return {
    [headers.vaspId]: vaspId.toString(),
    [headers.timestamp]: timestamp.toString(),
    [headers.signature]: await signer.signMessage({
      message: message(payload, timestamp),
    }),
  };
}

export async function verifyHttpRequest(
  payload: RequestPayload & { headers: Pick<Headers, "get"> },
  resolveVasp: ResolveVasp,
  now = unixSeconds(),
) {
  const vaspId = numberHeader(payload.headers.get(headers.vaspId), 0xffff_ffff);
  const timestamp = numberHeader(
    payload.headers.get(headers.timestamp),
    Number.MAX_SAFE_INTEGER,
  );
  const signature = payload.headers.get(headers.signature);
  const unauthorized = () =>
    new ServiceError(
      "INVALID_VASP_SIGNATURE",
      "VASP signature is missing, invalid, or expired",
      401,
    );
  if (
    vaspId === undefined ||
    vaspId === 0 ||
    timestamp === undefined ||
    Math.abs(now - timestamp) > maxClockSkewSeconds ||
    !signature ||
    !/^0x[0-9a-fA-F]{130}$/.test(signature)
  )
    throw unauthorized();
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: message(payload, timestamp),
      signature: signature as Hex,
    });
  } catch {
    throw unauthorized();
  }
  const vasp = await resolveVasp(vaspId);
  if (!vasp?.active || vasp.signer.toLowerCase() !== recovered.toLowerCase()) {
    throw unauthorized();
  }
  return { vaspId, timestamp, signer: recovered };
}
