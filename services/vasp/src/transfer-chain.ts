import {
  kycRegistryAbi,
  ledgerForwarderAbi,
  ledgerTokenAbi,
  travelRuleComplianceAbi,
} from "@ledgera/abis";
import type { Deployment } from "@ledgera/config";
import { signForwardRequest } from "@ledgera/shared/forward-request";
import {
  type Address,
  encodeFunctionData,
  getAbiItem,
  type Hex,
  type LocalAccount,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import type { registryChain } from "./chain.ts";
import type { ForwardPayload, IncomingTransfer } from "./db/transfers.ts";
import { matchesForwardCall } from "./transfer-gateway.ts";

const transferEvent = getAbiItem({ abi: ledgerTokenAbi, name: "Transfer" });
const travelRuleEvent = getAbiItem({
  abi: ledgerTokenAbi,
  name: "TravelRuleTransfer",
});

const forwardEvent = getAbiItem({
  abi: ledgerForwarderAbi,
  name: "ExecutedForwardRequest",
});
const recoverySpan = 1_000n;

export function transferChain(
  client: ReturnType<typeof registryChain>["client"],
  deployment: Deployment,
) {
  const contracts = deployment.contracts;
  const tokens = { tJPY: contracts.tJPY, tUSD: contracts.tUSD };
  return {
    tokens,
    forwarder: contracts.ledgerForwarder,
    chainId: deployment.chainId,
    startBlock: BigInt(deployment.auditStartBlock),
    isAnvil: deployment.environment === "anvil",
    block(
      input: { blockNumber: bigint } | { blockTag: "latest" | "finalized" },
    ) {
      return client.getBlock(input);
    },
    async recipient(address: Address) {
      const block = await client.getBlock({ blockTag: "latest" });
      const options = {
        address: contracts.kycRegistry,
        abi: kycRegistryAbi,
        blockHash: block.hash,
        requireCanonical: true,
        args: [address],
      } as const;
      const [eligible, vaspId] = await Promise.all([
        client.readContract({ ...options, functionName: "isHolder" }),
        client.readContract({ ...options, functionName: "vaspOf" }),
      ]);
      return { eligible, vaspId };
    },
    needsTravelRule(from: Address, to: Address) {
      return client.readContract({
        address: contracts.travelRuleCompliance,
        abi: travelRuleComplianceAbi,
        functionName: "requiresTravelRule",
        args: [from, to],
      });
    },
    async plan(
      signer: LocalAccount,
      token: Address,
      to: Address,
      amount: bigint,
    ) {
      const [nonce, finalized] = await Promise.all([
        client.readContract({
          address: contracts.ledgerForwarder,
          abi: ledgerForwarderAbi,
          functionName: "nonces",
          args: [signer.address],
        }),
        client.getBlock({ blockTag: "finalized" }),
      ]);
      const data = encodeFunctionData({
        abi: ledgerTokenAbi,
        functionName: "transfer",
        args: [to, amount],
      });
      const request = {
        from: signer.address,
        to: token,
        value: 0n,
        gas: 200_000n,
        deadline: Math.floor(Date.now() / 1000) + 300,
        nonce,
        data,
      };
      const signature = await signForwardRequest(
        signer,
        {
          chainId: deployment.chainId,
          verifyingContract: contracts.ledgerForwarder,
        },
        request,
      );
      return {
        nonce,
        firstBlock:
          deployment.environment === "anvil"
            ? BigInt(deployment.auditStartBlock)
            : finalized.number,
        request: {
          from: request.from,
          to: token,
          value: "0",
          gas: "200000",
          deadline: request.deadline,
          data,
          signature,
        },
      };
    },
    async finalizedRequest(
      request: ForwardPayload,
      nonce: bigint,
      firstBlock: bigint,
    ) {
      const finalized = await client.getBlock({ blockTag: "finalized" });
      const current = await client.readContract({
        address: contracts.ledgerForwarder,
        abi: ledgerForwarderAbi,
        functionName: "nonces",
        args: [request.from],
        blockHash: finalized.hash,
        requireCanonical: true,
      });
      if (current <= nonce)
        return finalized.timestamp > BigInt(request.deadline)
          ? { status: "expired" as const }
          : undefined;
      for (
        let fromBlock = firstBlock;
        fromBlock <= finalized.number;
        fromBlock += recoverySpan
      ) {
        const end = fromBlock + recoverySpan - 1n;
        const logs = await client.getLogs({
          address: contracts.ledgerForwarder,
          event: forwardEvent,
          args: { signer: request.from },
          fromBlock,
          toBlock: end < finalized.number ? end : finalized.number,
          strict: true,
        });
        const consumed = logs.find((log) => log.args.nonce === nonce);
        if (!consumed) continue;
        if (
          (await client.getBlock({ blockNumber: consumed.blockNumber }))
            .hash !== consumed.blockHash
        )
          return;
        return {
          status: "consumed" as const,
          hash: consumed.transactionHash,
          blockHash: consumed.blockHash,
        };
      }
    },
    async execution(
      hash: Hex,
      request: ForwardPayload,
      beneficiary: Address,
      amount: bigint,
      nonce: bigint,
    ) {
      try {
        const [transaction, receipt] = await Promise.all([
          client.getTransaction({ hash }),
          client.getTransactionReceipt({ hash }),
        ]);
        if (
          transaction.hash !== hash ||
          receipt.transactionHash !== hash ||
          transaction.blockHash !== receipt.blockHash
        )
          return;
        const matches =
          transaction.to?.toLowerCase() ===
            contracts.ledgerForwarder.toLowerCase() &&
          matchesForwardCall(transaction.input, request);
        if (!matches)
          return { ...receipt, matches, executed: false, logIndex: undefined };
        const executed = parseEventLogs({
          abi: [forwardEvent],
          eventName: "ExecutedForwardRequest",
          logs: receipt.logs.filter(
            (log) =>
              log.address.toLowerCase() ===
              contracts.ledgerForwarder.toLowerCase(),
          ),
          strict: true,
        }).some(
          ({ args }) =>
            args.signer.toLowerCase() === request.from.toLowerCase() &&
            args.nonce === nonce,
        );
        const transfers = parseEventLogs({
          abi: [transferEvent],
          eventName: "Transfer",
          logs: receipt.logs.filter(
            (log) => log.address.toLowerCase() === request.to.toLowerCase(),
          ),
          strict: true,
        });
        const logIndex = transfers.find(
          ({ args }) =>
            args.from.toLowerCase() === request.from.toLowerCase() &&
            args.to.toLowerCase() === beneficiary.toLowerCase() &&
            args.value === amount,
        )?.logIndex;
        return { ...receipt, matches, executed, logIndex };
      } catch (error) {
        if (
          !(error instanceof TransactionReceiptNotFoundError) &&
          !(error instanceof TransactionNotFoundError)
        )
          throw error;
      }
    },
    async events(blockHash: Hex): Promise<IncomingTransfer[]> {
      const logs = await client.getLogs({
        address: Object.values(tokens),
        blockHash,
        events: [transferEvent, travelRuleEvent],
        strict: true,
      });
      const entries: IncomingTransfer[] = [];
      const latest = new Map<string, IncomingTransfer>();
      for (const log of logs.sort((a, b) => a.logIndex - b.logIndex)) {
        const identity = `${log.transactionHash}:${log.address.toLowerCase()}`;
        if (log.eventName === "Transfer") {
          const entry = {
            from: log.args.from,
            to: log.args.to,
            amount: log.args.value,
            token: log.address,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
          };
          entries.push(entry);
          latest.set(identity, entry);
        } else {
          const entry = latest.get(identity);
          if (
            entry &&
            entry.from === log.args.from &&
            entry.to === log.args.to &&
            entry.amount === log.args.amount
          ) {
            entry.refId = log.args.refId;
          }
        }
      }
      return entries;
    },
  };
}
