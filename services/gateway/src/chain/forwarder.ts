import { EventEmitter, once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { logService } from "@ledgera/shared/server";
import {
  BaseError,
  RpcRequestError,
  TransactionReceiptNotFoundError,
} from "viem";
import type { GatewayStore } from "../db/store.ts";
import type { SequencerClient } from "./sequencer.ts";

type ForwardOutcome = {
  status: "forwarded" | "rejected";
  error: string | null;
};

export class ForwardNotifications {
  private readonly events = new EventEmitter();

  publish(seq: bigint, outcome: ForwardOutcome) {
    this.events.emit(seq.toString(), {
      status: outcome.status,
      error: outcome.error,
    });
  }

  async wait(
    store: Pick<GatewayStore, "forwardResult">,
    seq: bigint,
    signal: AbortSignal,
  ): Promise<ForwardOutcome | undefined> {
    const listener = new AbortController();
    const update = once(this.events, seq.toString(), {
      signal: AbortSignal.any([signal, listener.signal]),
    }).then(
      ([outcome]) => outcome as ForwardOutcome,
      () => undefined,
    );
    try {
      const persisted = store.forwardResult(seq).then((current) => {
        if (current?.status === "forwarded" || current?.status === "rejected") {
          return { status: current.status, error: current.error };
        }
        return update;
      });
      return await Promise.race([persisted, update]);
    } finally {
      listener.abort();
    }
  }
}

export function classifyForwardError(error: unknown) {
  const rpc =
    error instanceof BaseError
      ? error.walk((cause) => cause instanceof RpcRequestError)
      : undefined;
  if (!(rpc instanceof RpcRequestError)) return { kind: "retry" } as const;

  const detail = rpc.details ?? rpc.shortMessage;
  if (/already known|already imported/i.test(detail))
    return { kind: "known" } as const;
  if (/nonce too low|nonce has already been used/i.test(detail))
    return { kind: "nonce" } as const;
  if (/ledgera: sender not allowed/i.test(detail))
    return { kind: "kyc" } as const;
  if (/insufficient funds/i.test(detail))
    return { kind: "rejected", reason: "insufficient funds" } as const;
  if (/intrinsic gas too low/i.test(detail))
    return { kind: "rejected", reason: "intrinsic gas too low" } as const;
  if (
    [-32005, -32002, -32603].includes(rpc.code) ||
    /pool is full|transaction pool full|timed? out|temporarily unavailable/i.test(
      detail,
    )
  )
    return { kind: "retry" } as const;
  return {
    kind: "rejected",
    reason: `sequencer rejected transaction (RPC ${rpc.code})`,
  } as const;
}

export async function runForwarder(
  store: GatewayStore,
  client: SequencerClient,
  notifications: ForwardNotifications,
  signal: AbortSignal,
  synchronize: () => Promise<void>,
) {
  let failures = 0;
  while (!signal.aborted) {
    let seq: bigint | undefined;
    try {
      await synchronize();
      const next = await store.queued();
      if (next) {
        seq = next.seq;
        let outcome: ForwardOutcome;
        try {
          const sent = await client.sendRawTransaction({
            serializedTransaction: next.rawTx,
          });
          outcome =
            sent.toLowerCase() === next.txHash.toLowerCase()
              ? { status: "forwarded", error: null }
              : {
                  status: "rejected",
                  error: "sequencer returned a different transaction hash",
                };
        } catch (error) {
          const failure = classifyForwardError(error);
          switch (failure.kind) {
            case "known":
              outcome = { status: "forwarded", error: null };
              break;
            case "nonce":
              try {
                await client.getTransactionReceipt({ hash: next.txHash });
                outcome = { status: "forwarded", error: null };
              } catch (findError) {
                if (!(findError instanceof TransactionReceiptNotFoundError))
                  throw findError;
                outcome = { status: "rejected", error: "nonce too low" };
              }
              break;
            case "kyc":
              outcome = {
                status: "rejected",
                error: `ledgera: sender not allowed: ${next.sender}`,
              };
              break;
            case "rejected":
              outcome = { status: "rejected", error: failure.reason };
              break;
            case "retry":
              throw error;
          }
        }
        const settled = await store.setForwardResult(
          next.seq,
          outcome.status,
          outcome.error,
        );
        for (const result of settled) notifications.publish(result.seq, result);
        failures = 0;
        continue;
      }
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures % 20 === 1) {
        logService("gateway", "error", "Retrying sequencer forwarding", null, {
          seq: seq?.toString(),
          attempts: failures,
          errorName: error instanceof Error ? error.name : "Error",
        });
      }
    }
    await setTimeout(250, undefined, { signal }).catch(() => {});
  }
}
