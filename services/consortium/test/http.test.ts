import { signHttpRequest } from "@ledgera/shared/http-signature";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { expect, test, vi } from "vitest";
import { consortiumApp } from "../src/http.ts";
import type { consortiumChain } from "../src/safe.ts";
import type { consortiumService } from "../src/service.ts";

const signer = privateKeyToAccount(generatePrivateKey());
const address = "0x1111111111111111111111111111111111111111";
const route = "http://consortium.invalid/v1/proposals";
const timestamp = Math.floor(Date.now() / 1000);

async function signed(input: object, vaspId = 1) {
  const request = new Request(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const signature = await signHttpRequest(signer, request, vaspId, timestamp);
  for (const [key, value] of Object.entries(signature))
    request.headers.set(key, value);
  return request;
}

function fixture(active = true) {
  const create = vi.fn(async (_input, _by, digest: Hex) => ({ id: digest }));
  const service = { create } as unknown as ReturnType<typeof consortiumService>;
  const registry = {
    overview: async () => ({ address, nonce: 0n, threshold: 2, owners: [] }),
    vasp: async () => ({ active, signer: signer.address }),
  } as Pick<ReturnType<typeof consortiumChain>, "overview" | "vasp">;
  return { create, app: consortiumApp(service, registry, [], "admin-fixture") };
}

const unblock = {
  type: "UNBLOCK_ACCOUNT",
  params: { account: address },
  reason: "Fixture review",
};

test("binds a signed proposal to its VASP and accepts only account actions", async () => {
  const { create, app } = fixture();
  for (const input of [
    { ...unblock, requestedBy: { vaspId: 2 } },
    { ...unblock, requestedBy: { memberId: 1 } },
    { ...unblock, type: "RAW", params: { to: address, data: "0x" } },
  ]) {
    const result = await app.fetch(await signed(input));
    expect(result.status).toBe(403);
  }
  expect(create).not.toHaveBeenCalled();
});

test("forwards the same verified digest on retries and rejects an inactive VASP", async () => {
  const { create, app } = fixture();
  const request = { ...unblock, requestedBy: { vaspId: 1 } };
  const first = await app.fetch(await signed(request));
  const second = await app.fetch(await signed(request));
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(await first.json()).toEqual(await second.json());
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0]?.[1]).toEqual({ vaspId: 1 });
  expect(create.mock.calls[0]?.[2]).toEqual(create.mock.calls[1]?.[2]);
  expect((await fixture(false).app.fetch(await signed(request))).status).toBe(
    401,
  );
});
