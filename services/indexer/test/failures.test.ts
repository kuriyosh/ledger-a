import { ledgerForwarderAbi } from "@ledgera/abis";
import { type Address, encodeErrorResult } from "viem";
import { expect, test } from "vitest";
import { errorDecoder } from "../src/decode.ts";
import { deepestFailure, evaluateDeposit } from "../src/failures.ts";
import { indexerRpc } from "../src/rpc.ts";

const address = "0x1111111111111111111111111111111111111111" as Address;

test("prefers a deep failed call over successful calls and wrappers", () => {
  const data = encodeErrorResult({
    abi: ledgerForwarderAbi,
    errorName: "SignerNotAllowed",
    args: [address],
  });
  const failed = { to: address, error: "execution reverted", output: data };
  const deepest = deepestFailure({
    error: "execution reverted",
    calls: [
      { calls: [{ calls: [{ output: "0x1234" }] }] },
      { error: "execution reverted", calls: [failed] },
    ],
  });
  expect(deepest).toEqual(failed);
  const decode = errorDecoder({
    kycRegistry: address,
    ledgerForwarder: address,
    travelRuleCompliance: address,
    tJPY: address,
    tUSD: address,
    atomicSwap: address,
    receiptLog: address,
    depositProbe: address,
    consortiumSafe: address,
  });
  expect(decode(undefined, data)).toEqual({
    errorName: "SignerNotAllowed",
    args: { signer: address },
  });
});

test("checks deposit expiry and VASP suspension at the transaction timestamp", () => {
  const account = { vaspId: 2, kind: 1, status: 1, validUntil: 12n };
  expect(evaluateDeposit(account, 1, 12n)).toBeUndefined();
  expect(evaluateDeposit(account, 1, 13n)).toMatchObject({
    validUntil: "12",
    accountStatus: 1,
  });
  expect(evaluateDeposit(account, 2, 12n)).toMatchObject({ vaspStatus: 2 });
  expect(evaluateDeposit({ ...account, status: 3 }, 1, 12n)).toMatchObject({
    accountStatus: 3,
  });
});

test("asks for the call tracer and treats method absence separately from an RPC error", async () => {
  const hash = `0x${"00".repeat(32)}` as const;
  const rpc = (code: number) =>
    indexerRpc("http://localhost:8545", "", async (_, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        method: "debug_traceTransaction",
        params: [hash, { tracer: "callTracer", timeout: "4s" }],
      });
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code } });
    });
  await expect(rpc(-32601).trace(hash)).resolves.toBeNull();
  await expect(rpc(-32000).trace(hash)).rejects.toThrow("incomplete");
});
