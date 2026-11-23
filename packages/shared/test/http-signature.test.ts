import { hashMessage, keccak256, recoverAddress, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test, vi } from "vitest";
import {
  signHttpRequest,
  signHttpRequestWithDigest,
  signHttpResponse,
  verifyHttpRequest,
  verifyHttpResponse,
} from "../src/http-signature.ts";

const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const other = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const timestamp = 1_795_000_000;
const url = "https://vasp-b.example/vasp/v1/rfq/quotes";
const json = '{"value":"￥", "amount":"123"}';
const bytes = Uint8Array.from(stringToBytes(json));
const unauthorized = { code: "INVALID_VASP_SIGNATURE", status: 401 };
const active = async () => ({ active: true, signer: signer.address });

function post(body: BodyInit = bytes, headers?: HeadersInit) {
  return new Request(url, { method: "POST", body, headers });
}

test("signs the exact UTF-8 bytes, method, URL pathname and decimal UNIX time", async () => {
  const request = post();
  const signed = await signHttpRequest(signer, request, 2, timestamp);
  expect(request.bodyUsed).toBe(false);
  const digest = hashMessage(
    `POST\n/vasp/v1/rfq/quotes\n1795000000\n${keccak256(bytes)}`,
  );
  expect(
    await recoverAddress({
      hash: digest,
      signature: signed["X-Ledgera-Signature"],
    }),
  ).toBe(signer.address);
  const lookup = vi.fn(active);
  for (const delta of [0, 300, -300]) {
    const verified = await verifyHttpRequest(
      post(bytes, signed),
      lookup,
      timestamp + delta,
    );
    expect(verified).toEqual({
      vaspId: 2,
      timestamp,
      signer: signer.address,
      digest,
      body: bytes,
    });
  }
  expect(lookup.mock.calls).toEqual([[2], [2], [2]]);
});

test("rejects modified bodies, paths, methods and times outside the permitted window", async () => {
  const headers = await signHttpRequest(signer, post(), 2, timestamp);
  for (const candidate of [
    post('{"value":"￥","amount":"123"}', headers),
    new Request("https://vasp-b.example/v1/proposals", {
      method: "POST",
      body: bytes,
      headers,
    }),
    new Request(`${url}?field=1`, { method: "POST", body: bytes, headers }),
    new Request(url, { method: "GET", headers }),
  ]) {
    await expect(
      verifyHttpRequest(candidate, active, timestamp),
    ).rejects.toMatchObject(unauthorized);
  }
  for (const delta of [301, -301]) {
    await expect(
      verifyHttpRequest(post(bytes, headers), active, timestamp + delta),
    ).rejects.toMatchObject(unauthorized);
  }
  await expect(
    verifyHttpRequest(post(), active, timestamp),
  ).rejects.toMatchObject(unauthorized);
});

test("requires the current signer's canonical signature and an active VASP ID", async () => {
  const headers = await signHttpRequest(signer, post(), 2, timestamp);
  for (const candidate of [
    undefined,
    { active: false, signer: signer.address },
    { active: true, signer: other.address },
  ]) {
    await expect(
      verifyHttpRequest(post(bytes, headers), async () => candidate, timestamp),
    ).rejects.toMatchObject(unauthorized);
  }
  const lookup = vi.fn(active);
  await expect(
    verifyHttpRequest(
      post(bytes, { ...headers, "X-Ledgera-Vasp-Id": "02" }),
      lookup,
      timestamp,
    ),
  ).rejects.toMatchObject(unauthorized);
  const signature = headers["X-Ledgera-Signature"];
  const highS = `${signature.slice(0, 66)}${"f".repeat(64)}${signature.slice(130)}`;
  const alternateV = `${signature.slice(0, 130)}01`;
  for (const invalid of [highS, alternateV]) {
    await expect(
      verifyHttpRequest(
        post(bytes, { ...headers, "X-Ledgera-Signature": invalid }),
        lookup,
        timestamp,
      ),
    ).rejects.toMatchObject(unauthorized);
  }
  expect(lookup).not.toHaveBeenCalled();
});

test("preserves binary bodies, including bytes that text decoding changes", async () => {
  const binary = Uint8Array.of(0xef, 0xbb, 0xbf, 0xff, 0xaa);
  const signed = await signHttpRequest(signer, post(binary), 2, timestamp);
  await expect(
    verifyHttpRequest(post(binary, signed), active, timestamp),
  ).resolves.toMatchObject({ body: binary });
  await expect(
    verifyHttpRequest(
      post(new TextDecoder().decode(binary), signed),
      active,
      timestamp,
    ),
  ).rejects.toMatchObject(unauthorized);

  const text = await signHttpRequest(signer, post("0xaa"), 2, timestamp);
  await expect(
    verifyHttpRequest(post("0xaa", text), active, timestamp),
  ).resolves.toMatchObject({ vaspId: 2 });
  await expect(
    verifyHttpRequest(post(Uint8Array.of(0xaa), text), active, timestamp),
  ).rejects.toMatchObject(unauthorized);
});

test("authenticates a response's exact bytes, status and originating request digest", async () => {
  const { digest } = await signHttpRequestWithDigest(
    other,
    post(),
    1,
    timestamp,
  );
  const signed = await signHttpResponse(
    signer,
    2,
    digest,
    200,
    bytes,
    timestamp,
  );
  const peer = { vaspId: 2, signer: signer.address };
  await expect(
    verifyHttpResponse(
      new Response(bytes, { headers: signed }),
      digest,
      peer,
      timestamp,
    ),
  ).resolves.toEqual(bytes);
  for (const response of [
    new Response("rejected", { headers: signed }),
    new Response(bytes, { headers: signed, status: 409 }),
    new Response(bytes),
  ]) {
    await expect(
      verifyHttpResponse(response, digest, peer, timestamp),
    ).rejects.toMatchObject(unauthorized);
  }
  const response = () => new Response(bytes, { headers: signed });
  await expect(
    verifyHttpResponse(response(), keccak256(bytes), peer, timestamp),
  ).rejects.toMatchObject(unauthorized);
  await expect(
    verifyHttpResponse(
      response(),
      digest,
      { ...peer, signer: other.address },
      timestamp,
    ),
  ).rejects.toMatchObject(unauthorized);
  await expect(
    verifyHttpResponse(response(), digest, peer, timestamp + 301),
  ).rejects.toMatchObject(unauthorized);
});
