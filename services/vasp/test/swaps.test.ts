import { ledgerForwarderAbi } from "@ledgera/abis";
import { encodeFunctionData, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { Swap } from "../src/db/swaps.ts";
import { type ForwardPayload, transferBytes } from "../src/db/transfers.ts";
import type { swapChain } from "../src/swap-chain.ts";
import { swapService } from "../src/swaps.ts";
import { matchesForwardCall } from "../src/transfer-gateway.ts";

const address = "0x0000000000000000000000000000000000000001";
const signature: Hex = `0x${"12".repeat(65)}`;
const hash: Hex = `0x${"34".repeat(32)}`;
const blockHash: Hex = `0x${"56".repeat(32)}`;
const replacementBlock: Hex = `0x${"78".repeat(32)}`;
const commands: [ForwardPayload, ForwardPayload] = [
  {
    from: address,
    to: address,
    value: "0",
    gas: "100",
    deadline: 2_000_000_000,
    data: "0x12",
    signature,
  },
  {
    from: address,
    to: address,
    value: "0",
    gas: "150",
    deadline: 2_000_000_000,
    data: "0x34",
    signature,
  },
];

function fixture(initial: Partial<Swap> = {}) {
  let row: Swap = {
    id: "q_1",
    customerId: "A-000001",
    status: "submitted",
    quote: {
      maker: address,
      taker: address,
      makerToken: address,
      takerToken: address,
      makerAmount: "1",
      takerAmount: "1",
      expiry: 2_000_000_000,
      nonce: hash,
    },
    quoteHash: transferBytes(hash),
    makerSignature: transferBytes(signature),
    gatewaySeq: null,
    firstGatewaySeq: 2n,
    forwardFirstBlock: 1n,
    forwardNonce: 0n,
    forwardRequests: commands,
    txHash: null,
    gatewayTxHash: null,
    blockHash: null,
    blockNumber: null,
    allowExpired: false,
    errorCode: null,
    simulationError: null,
    revision: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...initial,
  };
  const store: Parameters<typeof swapService>[0] = {
    list: vi.fn(),
    get: vi.fn(),
    submit: vi.fn(),
    recordExpired: vi.fn(),
    pending: vi.fn(async () => [row]),
    update: vi.fn(async (_, updates) => {
      row = { ...row, ...updates };
      return row;
    }),
  };
  const wallet = { signer: vi.fn() };
  const chain = {
    fills: vi.fn(),
    plan: vi.fn(),
    nonce: vi.fn().mockResolvedValue(0n),
    finalizedRequest: vi.fn<ReturnType<typeof swapChain>["finalizedRequest"]>(),
    receipt: vi.fn<ReturnType<typeof swapChain>["receipt"]>(),
  };
  const gateway = {
    head: vi.fn(),
    find: vi.fn(),
    forward: vi.fn(),
  };
  const service = swapService(store, wallet, chain, gateway, false);
  const tracked = vi.fn().mockResolvedValue(true);
  return {
    store,
    chain,
    gateway,
    tracked,
    read: () => row,
    replace: (updates: Partial<Swap>) => {
      row = { ...row, ...updates };
    },
    sweep: () => service.sweep(tracked, new AbortController().signal),
  };
}

function receipt(
  status: "success" | "reverted",
  position: Hex = blockHash,
): Awaited<ReturnType<ReturnType<typeof swapChain>["receipt"]>> {
  return {
    type: "eip1559",
    status,
    blockHash: position,
    blockNumber: 3n,
    transactionHash: hash,
    transactionIndex: 0,
    to: address,
    from: address,
    contractAddress: null,
    cumulativeGasUsed: 1n,
    effectiveGasPrice: 1n,
    gasUsed: 1n,
    logs: [],
    logsBloom: "0x",
    matches: true,
    filled: status === "success",
  };
}

describe("swap settlement", () => {
  it("recovers the Gateway Receipt after a lost response", async () => {
    const test = fixture();
    test.gateway.forward.mockResolvedValue({ status: "unavailable" });
    await test.sweep();
    expect(test.gateway.forward).toHaveBeenCalledWith(commands, false);
    test.gateway.find.mockResolvedValue({
      status: "accepted",
      seq: 2n,
      txHash: hash,
    });
    await test.sweep();
    expect(test.gateway.forward).toHaveBeenCalledTimes(1);
    test.chain.receipt.mockResolvedValue(receipt("success"));
    await test.sweep();
    expect(test.read()).toMatchObject({ status: "confirmed", gatewaySeq: 2n });
  });

  it("holds a consumed nonce until its canonical receipt can be tracked", async () => {
    const test = fixture();
    test.chain.nonce.mockResolvedValue(2n);
    test.gateway.forward.mockResolvedValue({
      status: "rejected",
      code: "FORWARD_REVERT",
    });
    await test.sweep();
    expect(test.gateway.forward).not.toHaveBeenCalled();
    expect(test.read().status).toBe("submitted");
    test.chain.finalizedRequest.mockResolvedValue({
      status: "consumed",
      hash,
      blockHash,
    });
    test.chain.receipt.mockResolvedValue(receipt("success"));
    test.tracked.mockResolvedValueOnce(false);
    await test.sweep();
    expect(test.gateway.forward).not.toHaveBeenCalled();
    expect(test.read().status).toBe("submitted");
    await test.sweep();
    expect(test.read()).toMatchObject({
      status: "confirmed",
      txHash: transferBytes(hash),
    });
  });

  it("keeps a request rejected without a Gateway Receipt until expiry is finalized", async () => {
    const test = fixture();
    test.gateway.forward.mockResolvedValue({
      status: "rejected",
      code: "FORWARD_REVERT",
    });
    await test.sweep();
    expect(test.read()).toMatchObject({
      status: "submitted",
      simulationError: "FORWARD_REVERT",
    });
    test.chain.finalizedRequest.mockResolvedValue({ status: "expired" });
    await test.sweep();
    expect(test.read()).toMatchObject({
      status: "failed",
      errorCode: "FORWARD_REVERT",
    });
  });

  it("keeps a reverted receipt through expiry and accepts a tracked replacement", async () => {
    const test = fixture({
      txHash: transferBytes(hash),
      gatewayTxHash: transferBytes(hash),
      gatewaySeq: 2n,
      simulationError: "QuoteExpired",
    });
    test.chain.receipt.mockResolvedValue(receipt("reverted"));
    await test.sweep();
    expect(test.read()).toMatchObject({
      status: "submitted",
      errorCode: "QuoteExpired",
      blockNumber: 3n,
    });
    test.chain.finalizedRequest.mockResolvedValue({ status: "expired" });
    await test.sweep();
    expect(test.read()).toMatchObject({
      status: "failed",
      errorCode: "QuoteExpired",
    });

    test.replace({
      status: "submitted",
      blockNumber: null,
      blockHash: null,
      errorCode: null,
    });
    test.chain.receipt.mockResolvedValue(receipt("success", replacementBlock));
    await test.sweep();
    expect(test.read()).toMatchObject({
      status: "confirmed",
      blockHash: transferBytes(replacementBlock),
      gatewaySeq: 2n,
      errorCode: null,
    });
  });

  it("matches both signed operations in order only in the atomic batch entry point", () => {
    const payload = commands.map((item) => ({
      ...item,
      value: BigInt(item.value),
      gas: BigInt(item.gas),
    }));
    const data = encodeFunctionData({
      abi: ledgerForwarderAbi,
      functionName: "executeAll",
      args: [payload],
    });
    const nonAtomic = encodeFunctionData({
      abi: ledgerForwarderAbi,
      functionName: "executeBatch",
      args: [payload, address],
    });
    expect(matchesForwardCall(data, commands)).toBe(true);
    expect(matchesForwardCall(data, [...commands].reverse())).toBe(false);
    expect(matchesForwardCall(nonAtomic, commands)).toBe(false);
    expect(matchesForwardCall(nonAtomic, commands[0])).toBe(true);
  });
});
