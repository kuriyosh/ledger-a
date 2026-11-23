import { setTimeout } from "node:timers/promises";
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
) {
  const batchSize = 50;
  let cursor: string | undefined;

  async function canonicalReceipt(hash: Hex) {
    const result = await registry.receipt(hash);
    if (
      result &&
      (await chain.block({ blockNumber: result.blockNumber })).hash ===
        result.blockHash
    )
      return result;
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
    if (!row.txHash)
      throw new Error("Submitted transfer has no transaction hash");
    const result = await canonicalReceipt(bytesToHex(row.txHash));
    if (!result) return;
    await store.update(row, {
      status: result.success ? "confirmed" : "failed",
      blockNumber: result.blockNumber,
      blockHash: transferBytes(result.blockHash),
      errorCode: result.success ? null : (row.simulationError ?? "REVERTED"),
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
      requested = await chain.plan(signer, token, counterparty, row.amount);
      initial = (await gateway.head()) + 1n;
      const retained = await store.update(row, {
        forwardRequest: requested,
        firstGatewaySeq: initial,
        counterpartyVaspId: vaspId,
      });
      if (!retained) return;
      row = retained;
      fresh = true;
    }
    let result =
      (!fresh ? await gateway.find(requested, initial) : undefined) ??
      (await gateway.forward(requested, row.submitOnRevert));
    if (result.status === "rejected" && !result.receipt)
      result = (await gateway.find(requested, initial)) ?? result;
    if (result.status === "unavailable") return;
    if (result.status === "rejected") {
      await store.update(row, {
        status: "failed",
        errorCode: result.code,
        txHash: result.receipt
          ? transferBytes(result.receipt.txHash)
          : undefined,
        gatewaySeq: result.receipt?.seq,
      });
      return;
    }
    await store.update(row, {
      status: "submitted",
      txHash: transferBytes(result.txHash),
      gatewaySeq: result.seq,
      simulationError: result.simulationError,
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

  async function poll(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await track();
        for (const wallet of await store.orphanedWallets()) {
          const check = await canonicalReceipt(wallet.hash);
          if (check?.success)
            await store.restoreWallet(wallet.id, wallet.hash, check);
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
      } catch (error) {
        if (!signal.aborted)
          logService("vasp", "error", "Transfer scan did not advance", null, {
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
