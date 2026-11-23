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
} from "viem";
import type { registryChain } from "./chain.ts";
import type { IncomingTransfer } from "./db/transfers.ts";

const transferEvent = getAbiItem({ abi: ledgerTokenAbi, name: "Transfer" });
const travelRuleEvent = getAbiItem({
  abi: ledgerTokenAbi,
  name: "TravelRuleTransfer",
});

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
      const nonce = await client.readContract({
        address: contracts.ledgerForwarder,
        abi: ledgerForwarderAbi,
        functionName: "nonces",
        args: [signer.address],
      });
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
        from: request.from,
        to: token,
        value: "0",
        gas: "200000",
        deadline: request.deadline,
        data,
        signature,
      };
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
