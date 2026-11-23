import { setTimeout } from "node:timers/promises";
import { TransactionNotFoundError } from "viem";
import type { GatewayStore } from "../db/store.ts";
import type { SequencerClient } from "./sequencer.ts";

type Outcome = { status: "forwarded" | "rejected"; error: string | null };

export async function runForwarder(
  store: GatewayStore,
  client: SequencerClient,
  signal: AbortSignal,
) {
  while (!signal.aborted) {
    try {
      const next = await store.queued();
      if (next) {
        let outcome: Outcome;
        try {
          const sent = await client.sendRawTransaction({
            serializedTransaction: next.rawTx,
          });
          if (sent.toLowerCase() !== next.txHash.toLowerCase()) {
            throw new Error("Sequencer returned a different transaction hash");
          }
          outcome = { status: "forwarded", error: null };
        } catch (error) {
          const reason = error instanceof Error ? error.message : "";
          if (/already known|already imported/i.test(reason)) {
            outcome = { status: "forwarded", error: null };
          } else if (
            /nonce too low|nonce has already been used/i.test(reason)
          ) {
            try {
              await client.getTransaction({ hash: next.txHash });
              outcome = { status: "forwarded", error: null };
            } catch (findError) {
              if (!(findError instanceof TransactionNotFoundError))
                throw findError;
              outcome = { status: "rejected", error: "nonce too low" };
            }
          } else if (/intrinsic gas too low/i.test(reason)) {
            outcome = { status: "rejected", error: "intrinsic gas too low" };
          } else if (/insufficient funds/i.test(reason)) {
            outcome = { status: "rejected", error: "insufficient funds" };
          } else if (/ledgera: sender not allowed/i.test(reason)) {
            outcome = {
              status: "rejected",
              error: `ledgera: sender not allowed: ${next.sender}`,
            };
          } else {
            throw error;
          }
        }
        await store.setForwardResult(next.seq, outcome.status, outcome.error);
        continue;
      }
    } catch {
      // The earliest queued entry remains pending until the sequencer or database recovers.
    }
    await setTimeout(250, undefined, { signal }).catch(() => {});
  }
}
