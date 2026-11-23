import { BaseError, RpcRequestError, TimeoutError } from "viem";
import { expect, test } from "vitest";
import {
  classifyForwardError,
  ForwardNotifications,
} from "../src/chain/forwarder.ts";

function rpcError(code: number, message: string) {
  return new BaseError("Could not send transaction", {
    cause: new RpcRequestError({
      body: { method: "eth_sendRawTransaction" },
      error: { code, message },
      url: "http://localhost:8545",
    }),
  });
}

test("marks deterministic RPC responses as settled", () => {
  expect(
    classifyForwardError(
      rpcError(-32000, "replacement transaction underpriced"),
    ),
  ).toEqual({
    kind: "rejected",
    reason: "sequencer rejected transaction (RPC -32000)",
  });
  expect(
    classifyForwardError(rpcError(-32602, "invalid transaction")),
  ).toMatchObject({ kind: "rejected" });
  expect(classifyForwardError(rpcError(-32000, "already known"))).toEqual({
    kind: "known",
  });
  expect(classifyForwardError(rpcError(-32000, "nonce too low"))).toEqual({
    kind: "nonce",
  });
  expect(
    classifyForwardError(rpcError(-32000, "ledgera: sender not allowed")),
  ).toEqual({ kind: "kyc" });
});

test("leaves transport and temporary node failures queued", () => {
  expect(
    classifyForwardError(
      new TimeoutError({ url: "http://localhost:8545", body: {} }),
    ),
  ).toEqual({ kind: "retry" });
  expect(
    classifyForwardError(rpcError(-32005, "request limit exceeded")),
  ).toEqual({ kind: "retry" });
  expect(
    classifyForwardError(rpcError(-32000, "transaction pool full")),
  ).toEqual({ kind: "retry" });
});

test("stops waiting for a notification even if the database lookup is slow", async () => {
  const notifications = new ForwardNotifications();
  const controller = new AbortController();
  const result = notifications.wait(
    {
      forwardResult: () => new Promise(() => {}),
    },
    1n,
    controller.signal,
  );
  controller.abort();
  await expect(result).resolves.toBeUndefined();
});
