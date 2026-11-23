import { type Hex, zeroHash } from "viem";
import { expect, test, vi } from "vitest";
import { registryGateway } from "../src/chain.ts";
import type { RegistryRequest } from "../src/db/store.ts";

const intent: RegistryRequest = {
  customerId: "A-000001",
  action: "register",
  txHash: zeroHash,
  rawTx: "0x02",
  firstBlock: 1n,
  createdAt: new Date(1000),
};
const other: Hex = `0x${"1".repeat(64)}`;
const receipt = { seq: "5", txHash: intent.txHash };

function response(value: unknown) {
  return Response.json(value);
}

test("reports nonce consumption separately from a known Gateway rejection", async () => {
  const send = vi.fn<typeof fetch>();
  const gateway = registryGateway("http://localhost:8600", send);
  send.mockResolvedValueOnce(
    response({ error: { data: { reason: "NONCE_TOO_LOW" } } }),
  );
  await expect(gateway.submit(intent)).resolves.toBe("nonce_used");
  send.mockResolvedValueOnce(
    response({ error: { data: { reason: "SENDER_NOT_ALLOWED" } } }),
  );
  await expect(gateway.submit(intent)).resolves.toBe("rejected");
});

test("recognizes an accepted receipt in a retry response and checks duplicate delivery", async () => {
  const send = vi.fn<typeof fetch>();
  const gateway = registryGateway("http://localhost:8600", send);
  send.mockResolvedValueOnce(
    response({ error: { data: { reason: "SEQUENCER_UNAVAILABLE", receipt } } }),
  );
  await expect(gateway.submit(intent)).resolves.toBe("accepted");
  send
    .mockResolvedValueOnce(
      response({ error: { data: { reason: "DUPLICATE_TX" } } }),
    )
    .mockResolvedValueOnce(response(receipt))
    .mockResolvedValueOnce(
      response({
        entries: [{ txHash: intent.txHash, forwardStatus: "rejected" }],
      }),
    );
  await expect(gateway.submit(intent)).resolves.toBe("rejected");
  expect(send.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(
    ["/rpc", "/rpc", `/v1/receipts/${intent.txHash}`, "/v1/log"],
  );
});

test("preserves uncertainty if successful response identifies a different transaction", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ result: { txHash: other, receipt } }));
  const gateway = registryGateway("http://localhost:8600", send);
  await expect(gateway.submit(intent)).rejects.toMatchObject({
    code: "GATEWAY_UNAVAILABLE",
  });
});
