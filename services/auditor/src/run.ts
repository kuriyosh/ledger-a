import { setTimeout } from "node:timers/promises";
import { logService } from "@ledgera/shared/server";
import { type Address, keccak256, stringToHex } from "viem";
import {
  type AuditBlock,
  type AuditReceipt,
  audit,
  auditJson,
  checkReceipt,
  receiptEvidence,
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

function observation(
  seq: bigint,
  detail: string,
  evidence: Violation["evidence"],
  identity = evidence,
): Violation {
  return {
    check: "C2",
    type: "BROKEN_CHAIN",
    seqA: seq,
    detail,
    evidence,
    observationId: keccak256(stringToHex(JSON.stringify(auditJson(identity)))),
  };
}

export async function scanReceipts(
  gateway: RunnerOptions["gateway"],
  saved: AuditReceipt[],
  full: boolean,
  signal: AbortSignal,
) {
  const head = await gateway.head(signal);
  const receipts = new Map(saved.map((receipt) => [receipt.seq, receipt]));
  const last = saved.at(-1)?.seq ?? 0n;
  const firstWaiting = saved.find(
    (entry) =>
      entry.forwardStatus === "queued" || entry.forwardStatus === "held_demo",
  );
  let next = full ? 1n : (firstWaiting?.seq ?? (last > 0n ? last : 1n));
  const problems: Violation[] = [];
  const published = new Set<bigint>();

  while (next <= head.seq) {
    signal.throwIfAborted();
    const before = next;
    const page = await gateway.page(next, signal);
    for (const receipt of page) {
      if (receipt.seq > head.seq) continue;
      if (full) published.add(receipt.seq);
      const archived = receipts.get(receipt.seq);
      const observed = receiptEvidence(receipt);
      if (receipt.seq < next) {
        problems.push(
          observation(
            receipt.seq,
            "Gateway returned a duplicate or out-of-order sequence",
            {
              observed,
              expectedSeq: next,
            },
          ),
        );
      } else {
        next = receipt.seq + 1n;
      }
      if (archived) {
        const saved = receiptEvidence(archived);
        if (
          JSON.stringify(auditJson(saved)) !==
          JSON.stringify(auditJson(observed))
        ) {
          problems.push(
            observation(
              receipt.seq,
              "Gateway returned conflicting Receipt data",
              { archived: saved, observed },
            ),
          );
          continue;
        }
        archived.forwardStatus = receipt.forwardStatus;
        archived.forwardError = receipt.forwardError;
      } else {
        receipts.set(receipt.seq, receipt);
      }
    }
    if (next === before) break;
  }

  if (full) {
    const missing = saved.filter(
      ({ seq }) => seq < next && seq <= head.seq && !published.has(seq),
    );
    if (missing.length) {
      const repeated = await gateway.head(signal);
      if (repeated.seq >= head.seq) {
        for (const receipt of missing) {
          problems.push(
            observation(
              receipt.seq,
              "Gateway omitted an archived Receipt",
              { archived: receiptEvidence(receipt), advertised: head },
              {
                seq: receipt.seq,
                entryHash: receipt.entryHash,
                signature: receipt.signature,
              },
            ),
          );
        }
      }
    }
  }

  const ordered = [...receipts.values()].sort((a, b) =>
    a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1,
  );
  return { receipts: ordered, head, problems };
}

type BlockLookup = Pick<RunnerOptions["source"], "blockHash">;

export async function isLagging(
  source: BlockLookup,
  saved: readonly AuditBlock[],
  tip: bigint,
) {
  const previous = saved.at(-1);
  if (!previous || tip >= previous.number) return false;
  const known = saved.find((block) => block.number === tip);
  return !known || (await source.blockHash(tip)) === known.hash;
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
  let loaded: Awaited<ReturnType<AuditStore["inputs"]>> | undefined;
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
    const saved = reset
      ? await store.inputs()
      : (loaded ?? (await store.inputs()));
    let retained = saved.blocks;
    const tip = await source.tip();
    if (await isLagging(source, retained, tip)) {
      if (reset)
        throw new Error("Audit RPC has not reached the previous checkpoint");
      return;
    }
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
    if (reset) retained = [];
    const added: AuditBlock[] = [];
    let previous = retained.at(-1);
    for (
      let from = reset ? firstBlock : ancestor + 1n;
      from <= tip;
      from += 250n
    ) {
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
    } = await scanReceipts(gateway, saved.receipts, reset, signal);
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
      saved.decisions,
    );
    const lastReceipt = receipts.at(-1);
    const lastSeq = lastReceipt?.seq ?? 0n;
    if (
      advertised.seq !== lastSeq ||
      advertised.entryHash !== (lastReceipt?.entryHash ?? policy.genesisHash)
    ) {
      const repeated = await gateway.head(signal);
      if (
        repeated.seq === advertised.seq &&
        repeated.entryHash === advertised.entryHash
      ) {
        const sequence = lastSeq > advertised.seq ? lastSeq : advertised.seq;
        problems.push(
          observation(
            sequence,
            "Gateway log does not match its advertised head",
            {
              advertised,
              archived: lastReceipt ? receiptEvidence(lastReceipt) : null,
            },
          ),
        );
      }
    }
    snapshot.violations.push(...problems);
    if (head && (await source.blockHash(head.number)) !== head.hash) {
      throw new Error("L2 changed before the audit checkpoint");
    }
    signal.throwIfAborted();
    const checkpoint = await store.persist({
      ancestor,
      blocks: added,
      snapshot,
      tip: head,
      lastSeq,
      reset,
      priorState: saved.state,
    });
    loaded = {
      blocks,
      receipts,
      decisions: new Map(
        snapshot.decisions.map((decision) => [decision.seq, decision]),
      ),
      state: checkpoint,
    };
  }

  function run(reset = false): Promise<void> {
    if (running)
      return reset && !runningReset
        ? running.catch(() => {}).then(() => run(true))
        : running;
    runningReset = reset;
    running = inspect(reset)
      .catch((error) => {
        loaded = undefined;
        throw error;
      })
      .finally(() => {
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
