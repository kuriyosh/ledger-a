import { setTimeout } from "node:timers/promises";
import { logService } from "@ledgera/shared/server";
import type { Address } from "viem";
import {
  type AuditBlock,
  type AuditReceipt,
  audit,
  checkReceipt,
  type Violation,
} from "./checks.ts";
import type { AuditStore } from "./db/store.ts";
import type { auditSource, gatewaySource } from "./sources.ts";

type RunnerOptions = {
  source: ReturnType<typeof auditSource>;
  gateway: ReturnType<typeof gatewaySource>;
  store: Pick<AuditStore, "inputs" | "persist">;
  startBlock: bigint;
  intervalMs: number;
  inclusionDeadlineMs: bigint;
  timeToleranceMs: bigint;
  signal: AbortSignal;
};

async function scanReceipts(
  gateway: RunnerOptions["gateway"],
  saved: AuditReceipt[],
  signal: AbortSignal,
) {
  const head = await gateway.head(signal);
  const receipts = [...saved];
  const verifiedUntil = saved.at(-1)?.seq ?? 0n;
  let next = verifiedUntil + 1n;
  const problems: Violation[] = [];

  while (next <= head.seq) {
    signal.throwIfAborted();
    const before = next;
    const page = await gateway.page(next, signal);
    if (!page.length) break;
    for (const receipt of page) {
      if (receipt.seq > head.seq) break;
      if (receipt.seq < next) {
        problems.push({
          check: "C2",
          type: "BROKEN_CHAIN",
          seqA: next - 1n,
          detail: "Gateway returned a duplicate or out-of-order sequence",
          evidence: { receipt, expectedSeq: next },
        });
        continue;
      }
      receipts.push(receipt);
      next = receipt.seq + 1n;
    }
    if (next === before) break;
  }

  const firstWaiting = saved.find(
    (entry) =>
      entry.forwardStatus === "queued" || entry.forwardStatus === "held_demo",
  );
  if (firstWaiting) {
    const updates = await gateway.page(firstWaiting.seq, signal);
    const bySeq = new Map(updates.map((entry) => [entry.seq, entry]));
    for (const receipt of receipts) {
      const updated = bySeq.get(receipt.seq);
      if (
        updated?.signature !== receipt.signature ||
        updated.entryHash !== receipt.entryHash
      )
        continue;
      receipt.forwardStatus = updated.forwardStatus;
      receipt.forwardError = updated.forwardError;
    }
  }

  return { receipts, head, problems };
}

export function createAuditRunner({
  source,
  gateway,
  store,
  startBlock,
  intervalMs,
  inclusionDeadlineMs,
  timeToleranceMs,
  signal,
}: RunnerOptions) {
  type SenderState = Awaited<ReturnType<typeof source.readSender>>;
  const historical = new Map<string, SenderState>();
  type ReceiptCheck = Awaited<ReturnType<typeof checkReceipt>>;
  const verified = new Map<bigint, { identity: string; state: ReceiptCheck }>();
  const verifyReceipt: typeof checkReceipt = async (
    receipt,
    policy,
    previous,
  ) => {
    const identity = [
      policy.chainId,
      policy.verifyingContract,
      policy.gatewaySigner,
      previous.seq,
      previous.hash,
      receipt.entryHash,
      receipt.signature,
      receipt.txHash,
      receipt.sender,
      receipt.receivedAtMs,
      receipt.prevHash,
    ].join(":");
    const saved = verified.get(receipt.seq);
    if (saved?.identity === identity) return saved.state;
    const state = await checkReceipt(receipt, policy, previous);
    verified.set(receipt.seq, { identity, state });
    return state;
  };
  let running: Promise<void> | undefined;
  let runningReset = false;

  async function readHistorical(
    sender: Address,
    block: Pick<AuditBlock, "number" | "hash">,
  ) {
    const key = `${sender}:${block.hash}`;
    const known = historical.get(key);
    if (known) return known;
    const result = await source.readSender(sender, block);
    if (historical.size >= 32_768) historical.clear();
    historical.set(key, result);
    return result;
  }

  async function inspect(reset: boolean) {
    signal.throwIfAborted();
    if (reset) {
      verified.clear();
      historical.clear();
    }
    const saved = await store.inputs();
    let retained = reset ? [] : saved.blocks;
    const tip = await source.tip();
    let keep = retained.length;

    while (keep > 0) {
      const block = retained[keep - 1];
      if (
        block.number <= tip &&
        (await source.blockHash(block.number)) === block.hash
      )
        break;
      keep--;
    }
    retained = retained.slice(0, keep);
    const firstBlock = startBlock - 1n;
    const ancestor = retained.at(-1)?.number ?? firstBlock - 1n;
    const added: AuditBlock[] = [];
    let previous = retained.at(-1);
    for (let from = ancestor + 1n; from <= tip; from += 250n) {
      signal.throwIfAborted();
      const lastInBatch = from + 249n;
      const to = lastInBatch <= tip ? lastInBatch : tip;
      const range = await source.blocks(from, to);
      if (range.length !== Number(to - from + 1n))
        throw new Error("Incomplete L2 block range");
      for (const block of range) {
        if (
          previous &&
          (block.number !== previous.number + 1n ||
            block.parentHash !== previous.hash)
        ) {
          throw new Error("L2 changed while scanning blocks");
        }
        added.push(block);
        previous = block;
      }
    }
    const blocks = [...retained, ...added];
    const head = blocks.at(-1);
    const {
      receipts,
      head: advertised,
      problems,
    } = await scanReceipts(gateway, reset ? [] : saved.receipts, signal);
    const policy = await source.policy();
    const snapshot = await audit(
      receipts,
      blocks,
      startBlock,
      {
        ...policy,
        inclusionDeadlineMs,
        timeToleranceMs,
      },
      readHistorical,
      verifyReceipt,
    );
    const lastReceipt = receipts.at(-1);
    const lastSeq = lastReceipt?.seq ?? 0n;
    if (
      advertised.seq !== lastSeq ||
      advertised.entryHash !== (lastReceipt?.entryHash ?? policy.genesisHash)
    ) {
      problems.push({
        check: "C2",
        type: "BROKEN_CHAIN",
        seqA: lastSeq > advertised.seq ? lastSeq : advertised.seq,
        detail: "Gateway log does not match its advertised head",
        evidence: {
          advertised,
          observedSeq: lastSeq,
          observedHash: lastReceipt?.entryHash,
        },
      });
    }
    snapshot.violations.push(...problems);
    if (head && (await source.blockHash(head.number)) !== head.hash) {
      throw new Error("L2 changed before the audit checkpoint");
    }
    signal.throwIfAborted();
    await store.persist({
      ancestor,
      blocks: added,
      snapshot,
      tip: head,
      lastSeq,
      reset,
      priorState: saved.state,
    });
  }

  function run(reset = false): Promise<void> {
    if (running)
      return reset && !runningReset
        ? running.catch(() => {}).then(() => run(true))
        : running;
    runningReset = reset;
    running = inspect(reset).finally(() => {
      running = undefined;
      runningReset = false;
    });
    return running;
  }

  async function poll() {
    while (!signal.aborted) {
      try {
        await run();
      } catch (error) {
        if (!signal.aborted)
          logService("auditor", "error", "Audit did not advance", null, {
            errorName: error instanceof Error ? error.name : "Error",
          });
      }
      await setTimeout(intervalMs, undefined, { signal }).catch(() => {});
    }
  }
  return { run, poll };
}
