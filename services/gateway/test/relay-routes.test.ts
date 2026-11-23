import { ledgerForwarderAbi, ledgerTokenAbi } from "@ledgera/abis";
import { signForwardRequest } from "@ledgera/shared/forward-request";
import { serviceApp } from "@ledgera/shared/server";
import {
  encodeErrorResult,
  encodeFunctionData,
  parseTransaction,
  RpcRequestError,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { ForwardNotifications } from "../src/chain/forwarder.ts";
import { simulationFailure } from "../src/chain/relay.ts";
import { relayRoutes } from "../src/routes/relay.ts";

const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const forwarder = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const swap = "0x3333333333333333333333333333333333333333";
const failure = {
  reverted: true,
  revertData: encodeErrorResult({
    abi: ledgerForwarderAbi,
    errorName: "SignerNotAllowed",
    args: [signer.address],
  }),
  errorName: "SignerNotAllowed",
  args: { signer: signer.address },
} as const;

function rpcFailure(message: string, data?: unknown) {
  return new RpcRequestError({
    body: {},
    error: { code: -32000, message, data },
    url: "http://localhost:8545",
  });
}

test("decodes canonical revert data and distinguishes non-EVM RPC errors", () => {
  expect(
    simulationFailure(
      rpcFailure("execution reverted", { data: failure.revertData }),
    ),
  ).toMatchObject({
    reverted: true,
    revertData: failure.revertData,
    errorName: "SignerNotAllowed",
  });
  expect(
    simulationFailure(rpcFailure("execution reverted", "0x12345678")),
  ).toEqual({ reverted: true, revertData: "0x12345678" });
  expect(simulationFailure(rpcFailure("insufficient funds"))).toBeUndefined();
});

test.each([120_000n, 1_500_000n, 4_990_000n])(
  "handles a simulation revert with %s requested gas",
  async (requestedGas) => {
    const request = {
      from: signer.address,
      to: token,
      value: 0n,
      gas: requestedGas,
      deadline: Math.floor(Date.now() / 1000) + 300,
      nonce: 0n,
      data: encodeFunctionData({
        abi: ledgerTokenAbi,
        functionName: "approve",
        args: [swap, 10n],
      }),
    } as const;
    const signature = await signForwardRequest(
      signer,
      { chainId: 31337, verifyingContract: forwarder },
      request,
    );
    const app = serviceApp("gateway-test");
    let submitted = 0;
    app.route(
      "/",
      relayRoutes({
        authorize: () => 1,
        relayers: new Map([[1, signer]]),
        chain: {
          async vaspOf() {
            return 1;
          },
          async forwarderNonce() {
            return 0n;
          },
          async isReverted() {
            return false;
          },
          async simulate() {
            return failure;
          },
        },
        stores: {
          notifications: new ForwardNotifications(),
          receipts: {
            async forwardResult() {
              return { status: "forwarded", error: null };
            },
          },
        },
        admission: {
          async acceptRelay(relay) {
            const transaction = parseTransaction(await relay.sign(0n));
            if (requestedGas < 1_000_000n) {
              expect(transaction.gas).toBe(1_000_000n);
            } else {
              expect(transaction.gas).toBeGreaterThan(
                (64n * requestedGas + 62n) / 63n,
              );
              expect(transaction.gas).toBeLessThanOrEqual(5_000_000n);
            }
            submitted++;
            return {
              seq: 1n,
              receivedAtMs: 1000n,
              sender: signer.address,
              txHash: zeroHash,
              prevHash: zeroHash,
              entryHash: zeroHash,
              signature,
            };
          },
        },
        signal: new AbortController().signal,
        policy: {
          chainId: 31337,
          forwarder,
          tokenAddresses: [token],
          swap,
          maxFee: 100_000_000_000n,
          fixedPriorityFee: 1n,
          fallbackGas: 1_000_000n,
          gasLimit: 5_000_000n,
        },
      }),
    );

    const send = (submitOnRevert: boolean) =>
      app.request("/relay/v1/forward", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              ...request,
              nonce: undefined,
              gas: request.gas.toString(),
              value: "0",
              signature,
            },
          ],
          submitOnRevert,
        }),
      });
    const rejected = await send(false);
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      error: { code: "SIMULATION_REVERTED", details: failure },
    });
    expect(submitted).toBe(0);
    const accepted = await send(true);
    if (requestedGas === 4_990_000n) {
      expect(accepted.status).toBe(422);
      expect(await accepted.json()).toMatchObject({
        error: { code: "GAS_LIMIT_TOO_HIGH" },
      });
      expect(submitted).toBe(0);
      return;
    }
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      receipt: { seq: "1" },
      simulation: failure,
    });
    expect(submitted).toBe(1);
  },
);
