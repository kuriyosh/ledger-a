import { setTimeout } from "node:timers/promises";
import type { openDatabase } from "@ledgera/shared/db";
import { logService } from "@ledgera/shared/server";
import { type Address, bytesToHex, getAddress, type Hex } from "viem";
import type { registryChain } from "./chain.ts";
import {
  type Transfer,
  type TransferStore,
  transferBytes,
  transferJson,
} from "./db/transfers.ts";
import type { transferChain } from "./transfer-chain.ts";
import type { transferGateway } from "./transfer-gateway.ts";

type Chain = ReturnType<typeof transferChain>;
type Gateway = ReturnType<typeof transferGateway>;
type Registry = Pick<ReturnType<typeof registryChain>, "receipt">;

export function transferService(
  store: TransferStore,
  chain: Chain,
  gateway: Gateway,
  registry: Registry,
  exclusive: Awaited<ReturnType<typeof openDatabase>>["exclusive"],
) {
  const batchSize = 50;
  let cursor: string | undefined;

  async function tracked(position: { blockNumber: bigint; blockHash: Hex }) {
    const known = await store.trackedBlock(position.blockNumber);
    if (!known) {
      if (
        chain.isAnvil ||
        (await chain.block({ blockTag: "finalized" })).number <
          position.blockNumber
      )
        return false;
    } else if (known.hash !== position.blockHash) {
      return false;
    }
    return (
      (await chain.block({ blockNumber: position.blockNumber })).hash ===
      position.blockHash
    );
  }

  async function expire(row: Transfer) {
    if (
      !row.forwardRequest ||
      row.forwardNonce === null ||
      !(await chain.expired(row.forwardRequest, row.forwardNonce))
    )
      return false;
    await store.update(row, {
      status: "failed",
      errorCode: row.simulationError ?? "FORWARD_REQUEST_EXPIRED",
    });
    return true;
  }

  function view(row: Transfer) {
    const token = bytesToHex(row.token).toLowerCase();
    const symbol = Object.entries(chain.tokens).find(
      ([, address]) => address.toLowerCase() === token,
    )?.[0];
    if (!symbol) throw new Error("Unknown token in transfer record");
    return transferJson(row, symbol);
  }

  async function submitted(row: Transfer) {
    if (!row.txHash || !row.forwardRequest)
      throw new Error("Submitted transfer has no signed request");
    const result = await chain.execution(
      bytesToHex(row.txHash),
      row.forwardRequest,
      bytesToHex(row.counterpartyAddress),
      row.amount,
    );
    if (!result) {
      await expire(row);
      return;
    }
    if (!(await tracked(result))) return;
    const confirmed =
      result.status === "success" && result.logIndex !== undefined;
    const errorCode =
      result.status === "success"
        ? "TRANSFER_EFFECT_MISSING"
        : (row.simulationError ?? "REVERTED");
    await store.update(row, {
      status: confirmed ? "confirmed" : "failed",
      blockNumber: result.blockNumber,
      blockHash: transferBytes(result.blockHash),
      logIndex: result.logIndex ?? null,
      errorCode: confirmed ? null : errorCode,
    });
  }

  async function route(row: Transfer) {
    if (row.status === "submitted") return submitted(row);
    let requested = row.forwardRequest;
    let initial = row.firstGatewaySeq;
    let fresh = false;
    if (!requested || initial === null) {
      const signer = await store.signer(row.customerId);
      const counterparty = getAddress(bytesToHex(row.counterpartyAddress));
      const token = getAddress(bytesToHex(row.token));
      let vaspId: number | undefined;
      if (!row.skipChecks) {
        const recipient = await chain.recipient(counterparty);
        if (!recipient.eligible) {
          await store.update(row, {
            status: "failed",
            errorCode: "BENEFICIARY_NOT_ELIGIBLE",
          });
          return;
        }
        vaspId = recipient.vaspId;
        if (await chain.needsTravelRule(signer.address, counterparty)) {
          await store.update(row, {
            status: "failed",
            errorCode: "TRAVEL_RULE_REQUIRED",
            counterpartyVaspId: vaspId,
          });
          return;
        }
      }
      const plan = await chain.plan(signer, token, counterparty, row.amount);
      requested = plan.request;
      initial = (await gateway.head()) + 1n;
      const retained = await store.update(row, {
        forwardRequest: requested,
        firstGatewaySeq: initial,
        forwardNonce: plan.nonce,
        counterpartyVaspId: vaspId,
      });
      if (!retained) return;
      row = retained;
      fresh = true;
    }
    let result: Awaited<ReturnType<Gateway["forward"]>> | undefined = !fresh
      ? await gateway.find(requested, initial)
      : undefined;
    if (!result && (await expire(row))) return;
    result ??= await gateway.forward(requested, row.submitOnRevert);
    if (result.status === "rejected" && !result.receipt)
      result = (await gateway.find(requested, initial)) ?? result;
    if (result.status === "unavailable") return;
    if (result.status === "rejected" && !result.receipt) {
      await store.update(row, { status: "failed", errorCode: result.code });
      return;
    }

    const recorded = result.status === "accepted" ? result : result.receipt;
    if (!recorded) throw new Error("Missing Gateway Receipt");
    await store.update(row, {
      status: "submitted",
      txHash: transferBytes(recorded.txHash),
      gatewaySeq: recorded.seq,
      simulationError:
        result.status === "accepted" ? result.simulationError : result.code,
    });
  }

  async function track() {
    const latest = await chain.block({ blockTag: "latest" });
    const former = await store.trackedTip();
    if (former && latest.number < former.number) {
      const known = await store.trackedBlock(latest.number);
      if (!known || known.hash === latest.hash) return;
    }
    let checkpoint = former;
    while (checkpoint) {
      if (
        checkpoint.number <= latest.number &&
        (await chain.block({ blockNumber: checkpoint.number })).hash ===
          checkpoint.hash
      )
        break;
      checkpoint = await store.trackedBlock(checkpoint.number - 1n);
    }
    const base = checkpoint?.number ?? chain.startBlock - 1n;
    if (former && former.number !== checkpoint?.number)
      await store.rewind(base);
    const maximum = base + 32n;
    const end = latest.number < maximum ? latest.number : maximum;
    let parent: Hex | undefined = checkpoint?.hash;
    for (let number = base + 1n; number <= end; number++) {
      const block =
        number === latest.number
          ? latest
          : await chain.block({ blockNumber: number });
      if (parent && block.parentHash !== parent)
        throw new Error("L2 changed while scanning transfers");
      const incoming = await chain.events(block.hash);
      await store.saveBlock(block, incoming);
      parent = block.hash;
    }
    if (!chain.isAnvil) {
      const finalized = await chain.block({ blockTag: "finalized" });
      await store.prune(finalized.number < end ? finalized.number : end);
    }
  }

  async function sweep(signal: AbortSignal) {
    try {
      await track();
      for (const wallet of await store.orphanedWallets()) {
        const check = await registry.receipt(wallet.hash);
        if (check?.success && (await tracked(check)))
          await store.restoreWallet(wallet.id, wallet.hash, check);
      }
    } catch (error) {
      if (!signal.aborted)
        logService("vasp", "error", "Transfer scan did not advance", null, {
          errorName: error instanceof Error ? error.name : "Error",
        });
    }

    const pending = await store.pending(cursor, batchSize);
    cursor = pending.length === batchSize ? pending.at(-1)?.id : undefined;
    for (const item of pending) {
      signal.throwIfAborted();
      try {
        await route(item);
      } catch (error) {
        logService("vasp", "error", "Transfer did not advance", null, {
          id: item.id,
          errorName: error instanceof Error ? error.name : "Error",
        });
      }
    }
  }

  async function poll(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await exclusive("transfer-reconcile", () => sweep(signal));
      } catch (error) {
        if (!signal.aborted)
          logService("vasp", "error", "Transfer worker did not advance", null, {
            errorName: error instanceof Error ? error.name : "Error",
          });
      }
      await setTimeout(2_000, undefined, { signal }).catch(() => {});
    }
  }

  return {
    async create(
      id: string,
      command: {
        to: Address;
        symbol: keyof Chain["tokens"];
        amount: bigint;
        beneficiaryName?: Transfer["beneficiaryName"];
        skipChecks: boolean;
        submitOnRevert: boolean;
      },
    ) {
      return view(
        await store.create(id, {
          ...command,
          token: chain.tokens[command.symbol],
        }),
      );
    },
    async list(id: string, limit: number) {
      return (await store.list(id, limit)).map(view);
    },
    async get(customerId: string, id: string) {
      return view(await store.get(customerId, id));
    },
    poll,
  };
}
