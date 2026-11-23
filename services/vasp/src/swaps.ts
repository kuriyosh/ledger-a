import { logService } from "@ledgera/shared/server";
import { bytesToHex, type Hex } from "viem";
import type { Swap, SwapStore } from "./db/swaps.ts";
import { type TransferStore, transferBytes } from "./db/transfers.ts";
import type { swapChain } from "./swap-chain.ts";
import type { transferGateway } from "./transfer-gateway.ts";

type Chain = ReturnType<typeof swapChain>;
type Gateway = ReturnType<typeof transferGateway>;
type Position = { blockNumber: bigint; blockHash: Hex };
const now = () => Math.floor(Date.now() / 1000);
const batchSize = 50;

function view(row: Swap) {
  return {
    id: row.id,
    quote: row.quote,
    status: row.status,
    txHash: row.txHash && bytesToHex(row.txHash),
    gatewayTxHash: row.gatewayTxHash && bytesToHex(row.gatewayTxHash),
    gatewaySeq: row.gatewaySeq?.toString() ?? null,
    blockNumber: row.blockNumber?.toString() ?? null,
    blockHash: row.blockHash && bytesToHex(row.blockHash),
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function swapService(
  store: SwapStore,
  wallets: Pick<TransferStore, "signer">,
  chain: Chain,
  gateway: Gateway,
  demo: boolean,
) {
  let cursor: string | undefined;

  async function settle(
    row: Swap,
    tracked: (position: Position) => Promise<boolean>,
  ) {
    const requests = row.forwardRequests;
    const fill = requests?.[1];
    if (
      !requests ||
      !fill ||
      row.forwardNonce === null ||
      row.forwardFirstBlock === null
    )
      throw new Error("Swap has no retained forward requests");
    const lookup = (hash: Hex) => chain.receipt(hash, row.quote, requests);

    async function confirm(
      receipt: NonNullable<Awaited<ReturnType<typeof lookup>>>,
    ) {
      if (!(await tracked(receipt))) return false;
      await store.update(row, {
        status: receipt.filled ? "confirmed" : "failed",
        txHash: transferBytes(receipt.transactionHash),
        blockNumber: receipt.blockNumber,
        blockHash: transferBytes(receipt.blockHash),
        errorCode: receipt.filled ? null : "SWAP_EFFECT_MISSING",
      });
      return true;
    }

    const receipt = row.txHash
      ? await lookup(bytesToHex(row.txHash))
      : undefined;
    if (receipt?.status === "success" && receipt.filled)
      return confirm(receipt);

    if (
      receipt?.status === "reverted" &&
      receipt.matches &&
      row.blockNumber === null &&
      (await tracked(receipt))
    ) {
      await store.update(row, {
        blockNumber: receipt.blockNumber,
        blockHash: transferBytes(receipt.blockHash),
        errorCode: row.simulationError ?? "REVERTED",
      });
      return false;
    }

    const state = await chain.finalizedRequest(
      fill,
      row.forwardNonce + 1n,
      row.forwardFirstBlock,
    );
    if (state?.status === "expired") {
      const absent =
        row.simulationError === "FORWARD_REJECTED"
          ? row.simulationError
          : "FORWARD_REQUEST_EXPIRED";
      await store.update(row, {
        status: "failed",
        errorCode: row.errorCode ?? absent,
      });
      return true;
    }
    if (state?.status === "consumed") {
      const actual =
        state.hash === receipt?.transactionHash
          ? receipt
          : await lookup(state.hash);
      if (actual?.status === "success" && actual.blockHash === state.blockHash)
        return confirm(actual);
    }
    return false;
  }

  async function process(
    row: Swap,
    tracked: (position: Position) => Promise<boolean>,
  ) {
    if (row.txHash) {
      await settle(row, tracked);
      return;
    }
    let requests = row.forwardRequests;
    let first = row.firstGatewaySeq;
    let fresh = false;
    if (!requests || first === null) {
      if (!row.allowExpired && row.quote.expiry <= now()) {
        await store.update(row, {
          status: "expired",
          errorCode: "QUOTE_EXPIRED",
        });
        return;
      }
      const signer = await wallets.signer(row.customerId);
      const plan = await chain.plan(
        signer,
        row.quote,
        bytesToHex(row.makerSignature),
      );
      const retained = await store.update(row, {
        forwardRequests: plan.requests,
        forwardNonce: plan.nonce,
        forwardFirstBlock: plan.firstBlock,
        firstGatewaySeq: (await gateway.head()) + 1n,
      });
      if (!retained || retained.firstGatewaySeq === null) return;
      row = retained;
      requests = plan.requests;
      first = retained.firstGatewaySeq;
      fresh = true;
    }
    let result: Awaited<ReturnType<Gateway["forward"]>> | undefined = fresh
      ? undefined
      : await gateway.find(requests, first);
    if (!result && !fresh && (await settle(row, tracked))) return;
    result ??= await gateway.forward(requests, demo);
    if (result.status === "rejected" && !result.receipt)
      result = (await gateway.find(requests, first)) ?? result;
    if (result.status === "unavailable") return;
    if (result.status === "rejected" && !result.receipt) {
      await store.update(row, { status: "failed", errorCode: result.code });
      return;
    }
    const recorded = result.status === "accepted" ? result : result.receipt;
    if (!recorded) throw new Error("Missing Gateway Receipt for swap");
    await store.update(row, {
      txHash: transferBytes(recorded.txHash),
      gatewayTxHash: transferBytes(recorded.txHash),
      gatewaySeq: recorded.seq,
      simulationError:
        result.status === "accepted" ? result.simulationError : result.code,
    });
  }

  return {
    fills: chain.fills,
    async submit(customerId: string, id: string, allowExpired: boolean) {
      return view(await store.submit(customerId, id, allowExpired, now()));
    },
    async get(customerId: string, id: string) {
      return view(await store.get(customerId, id));
    },
    async list(customerId: string, limit: number) {
      return (await store.list(customerId, limit)).map(view);
    },
    async sweep(
      tracked: (position: Position) => Promise<boolean>,
      signal: AbortSignal,
    ) {
      await store.recordExpired(now());
      const pending = await store.pending(cursor, batchSize);
      cursor = pending.length === batchSize ? pending.at(-1)?.id : undefined;
      for (const row of pending) {
        signal.throwIfAborted();
        try {
          await process(row, tracked);
        } catch (error) {
          logService("vasp", "error", "Swap did not advance", null, {
            id: row.id,
            errorName: error instanceof Error ? error.name : "Error",
          });
        }
      }
    },
  };
}
