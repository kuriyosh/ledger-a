import { hashMessage, keccak256, recoverAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test, vi } from "vitest";
import { signHttpRequest, verifyHttpRequest } from "../src/http-signature.ts";

const gateway = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const other = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const timestamp = 1_795_000_000;
const payload = {
  method: "POST",
  path: "/vasp/v1/rfq/quotes",
  body: toBytes('{"value":"￥", "amount":"123"}'),
};

test("signs the exact UTF-8 bytes, method, path and decimal UNIX time", async () => {
  const signed = await signHttpRequest(gateway, payload, 2, timestamp);
  const digest = hashMessage(
    `POST\n/vasp/v1/rfq/quotes\n1795000000\n${keccak256(payload.body)}`,
  );
  expect(
    await recoverAddress({
      hash: digest,
      signature: signed["X-Ledgera-Signature"],
    }),
  ).toBe(gateway.address);
  const lookup = vi.fn(async () => ({ active: true, signer: gateway.address }));
  for (const delta of [0, 300, -300]) {
    const verified = await verifyHttpRequest(
      { ...payload, headers: new Headers(signed) },
      lookup,
      timestamp + delta,
    );
    expect(verified).toEqual({ vaspId: 2, timestamp, signer: gateway.address });
  }
  expect(lookup.mock.calls).toEqual([[2], [2], [2]]);
});

test("rejects modified payloads and requests outside the time window", async () => {
  const headers = new Headers(
    await signHttpRequest(gateway, payload, 2, timestamp),
  );
  const lookup = vi.fn(async () => ({ active: true, signer: gateway.address }));
  const unauthorized = { code: "INVALID_VASP_SIGNATURE", status: 401 };
  for (const candidate of [
    { ...payload, body: '{"value":"￥","amount":"123"}' },
    { ...payload, path: "/v1/proposals" },
    { ...payload, path: `${payload.path}?field=1` },
    { ...payload, method: "GET" },
  ]) {
    await expect(
      verifyHttpRequest({ ...candidate, headers }, lookup, timestamp),
    ).rejects.toMatchObject(unauthorized);
  }
  for (const delta of [301, -301]) {
    await expect(
      verifyHttpRequest({ ...payload, headers }, lookup, timestamp + delta),
    ).rejects.toMatchObject(unauthorized);
  }
  await expect(
    verifyHttpRequest(
      { ...payload, headers: new Headers() },
      lookup,
      timestamp,
    ),
  ).rejects.toMatchObject(unauthorized);
});

test("requires the current signer of an active VASP and a valid ID header", async () => {
  const headers = new Headers(
    await signHttpRequest(gateway, payload, 2, timestamp),
  );
  const unauthorized = { code: "INVALID_VASP_SIGNATURE", status: 401 };
  for (const candidate of [
    undefined,
    { active: false, signer: gateway.address },
    { active: true, signer: other.address },
  ]) {
    await expect(
      verifyHttpRequest(
        { ...payload, headers },
        async () => candidate,
        timestamp,
      ),
    ).rejects.toMatchObject(unauthorized);
  }
  headers.set("X-Ledgera-Vasp-Id", "02");
  const lookup = vi.fn(async () => ({ active: true, signer: gateway.address }));
  await expect(
    verifyHttpRequest({ ...payload, headers }, lookup, timestamp),
  ).rejects.toMatchObject(unauthorized);
  expect(lookup).not.toHaveBeenCalled();
});

test("hashes hex-looking text as UTF-8 and preserves binary bodies", async () => {
  const text = { ...payload, body: "0xaa" };
  const binary = { ...payload, body: Uint8Array.of(0xaa) };
  const signature = await signHttpRequest(gateway, text, 2, timestamp);
  const lookup = async () => ({ active: true, signer: gateway.address });
  const headers = new Headers(signature);
  await expect(
    verifyHttpRequest({ ...text, headers }, lookup, timestamp),
  ).resolves.toMatchObject({ vaspId: 2 });
  await expect(
    verifyHttpRequest({ ...binary, headers }, lookup, timestamp),
  ).rejects.toMatchObject({ code: "INVALID_VASP_SIGNATURE" });
});
