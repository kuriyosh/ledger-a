import { type Hex, zeroHash } from "viem";
import { expect, test, vi } from "vitest";
import type { registryChain } from "../src/chain.ts";
import {
  type Transfer,
  type TransferStore,
  transferBytes,
} from "../src/db/transfers.ts";
import type { transferChain } from "../src/transfer-chain.ts";
import type { transferGateway } from "../src/transfer-gateway.ts";
import { transferService } from "../src/transfers.ts";

const alternative: Hex = `0x${"e".repeat(64)}`;
const blockHash: Hex = `0x${"a".repeat(64)}`;
const token = "0x1111111111111111111111111111111111111111";
const sender = "0x2222222222222222222222222222222222222222";
const receiver = "0x3333333333333333333333333333333333333333";
const included = {
  matches: true,
  executed: true,
  status: "success",
  transactionHash: zeroHash as Hex,
  logIndex: 7,
  blockNumber: 8n,
  blockHash,
};
function fixture() {
  const row: Transfer = {
    id: "transfer",
    status: "submitted",
    direction: "out",
    customerId: "fixture",
    token: transferBytes(token),
    beneficiaryName: null,
    txHash: transferBytes(zeroHash),
    gatewayTxHash: transferBytes(zeroHash),
    gatewaySeq: 1n,
    firstGatewaySeq: 1n,
    counterpartyVaspId: 1,
    refId: null,
    revision: 0,
    skipChecks: false,
    submitOnRevert: false,
    simulationError: null,
    errorCode: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    forwardRequest: {
      from: sender,
      to: token,
      value: "0",
      gas: "200000",
      deadline: 1_800_000_000,
      signature: "0x01",
      data: "0x02",
    },
    forwardNonce: 9n,
    forwardFirstBlock: 3n,
    amount: 14n,
    counterpartyAddress: transferBytes(receiver),
    blockNumber: null,
    blockHash: null,
    logIndex: null,
  };
  const update = vi.fn(async (_row: Transfer, update: Partial<Transfer>) =>
    Object.assign(row, update),
  );
  const settled = {
    update,
    pending: async () => [row],
    orphanedWallets: async () => [],
    trackedTip: async () => ({ number: 8n, hash: blockHash }),
    trackedBlock: vi.fn(async (_number: bigint) => ({
      number: 8n,
      hash: blockHash,
    })),
  };
  const execution = vi.fn(async (_hash: Hex) => ({
    ...included,
    logIndex: included.logIndex as number | undefined,
  }));
  const finalizedRequest = vi.fn<
    () => Promise<
      | undefined
      | { status: "expired" }
      | { status: "consumed"; hash: Hex; blockHash: Hex }
    >
  >(async () => undefined);
  const chain = {
    isAnvil: true,
    startBlock: 3n,
    block: async () => ({ number: 8n, hash: blockHash }),
    execution,
    finalizedRequest,
  };
  return {
    update,
    settled,
    execution,
    finalizedRequest,
    async sweep() {
      const controller = new AbortController();
      await transferService(
        settled as unknown as TransferStore,
        chain as unknown as ReturnType<typeof transferChain>,
        {} as ReturnType<typeof transferGateway>,
        {} as Pick<ReturnType<typeof registryChain>, "receipt">,
        {
          advance: vi.fn(),
          approval: vi.fn(),
          begin: vi.fn(),
          report: vi.fn(),
        },
        async (_name, run) => {
          try {
            await run();
          } finally {
            controller.abort();
          }
        },
      ).poll(controller.signal);
    },
  };
}

test("requires a tracked block and a Transfer event before confirming an executed request", async () => {
  const outside = fixture();
  outside.settled.trackedBlock.mockResolvedValue({
    number: 8n,
    hash: alternative,
  });
  await outside.sweep();
  expect(outside.update).not.toHaveBeenCalled();
  const absent = fixture();
  absent.execution.mockResolvedValue({ ...included, logIndex: undefined });
  await absent.sweep();
  expect(absent.update).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      status: "failed",
      errorCode: "TRANSFER_EFFECT_MISSING",
    }),
  );
});

test("keeps a reverted request live until the finalized deadline, then records its receipt", async () => {
  const reverted = fixture();
  reverted.execution.mockResolvedValue({
    ...included,
    status: "reverted",
    executed: false,
  });
  await reverted.sweep();
  expect(reverted.update).toHaveBeenCalledWith(expect.anything(), {
    blockNumber: 8n,
    blockHash: transferBytes(blockHash),
    errorCode: "REVERTED",
  });
  reverted.finalizedRequest.mockResolvedValue({ status: "expired" });
  await reverted.sweep();
  expect(reverted.update).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      status: "failed",
      blockNumber: 8n,
      errorCode: "REVERTED",
    }),
  );
});

test("takes the actual transaction from finalized nonce evidence", async () => {
  const consumed = fixture();
  consumed.execution.mockImplementation(async (hash) =>
    hash === zeroHash
      ? { ...included, status: "reverted", executed: false }
      : { ...included, matches: false, transactionHash: alternative },
  );
  consumed.finalizedRequest.mockResolvedValue({
    status: "consumed",
    hash: alternative,
    blockHash,
  });
  await consumed.sweep();
  await consumed.sweep();
  expect(consumed.update).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      status: "confirmed",
      txHash: transferBytes(alternative),
      logIndex: 7,
    }),
  );
});
