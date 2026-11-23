import { atomicSwapAbi, ledgerTokenAbi } from "@ledgera/abis";
import type { Deployment } from "@ledgera/config";
import { hashQuote } from "@ledgera/shared/quote";
import {
  encodeFunctionData,
  getAbiItem,
  type Hex,
  type LocalAccount,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import type { registryChain } from "./chain.ts";
import type { ForwardPayload } from "./db/transfers.ts";
import { type QuoteWire, quoteTyped } from "./quote-model.ts";
import type { transferChain } from "./transfer-chain.ts";
import { matchesForwardCall } from "./transfer-gateway.ts";

const filledEvent = getAbiItem({ abi: atomicSwapAbi, name: "Filled" });

export function swapChain(
  client: ReturnType<typeof registryChain>["client"],
  deployment: Deployment,
  transfers: Pick<
    ReturnType<typeof transferChain>,
    "sign" | "finalizedRequest"
  >,
) {
  const address = deployment.contracts.atomicSwap;
  const domain = { chainId: deployment.chainId, verifyingContract: address };

  return {
    plan(signer: LocalAccount, wire: QuoteWire, signature: Hex) {
      const quote = quoteTyped(wire);
      return transfers.sign(signer, [
        {
          to: quote.takerToken,
          gas: 100_000n,
          data: encodeFunctionData({
            abi: ledgerTokenAbi,
            functionName: "approve",
            args: [address, quote.takerAmount],
          }),
        },
        {
          to: address,
          gas: 500_000n,
          data: encodeFunctionData({
            abi: atomicSwapAbi,
            functionName: "fill",
            args: [quote, signature],
          }),
        },
      ]);
    },
    async fills(blockHash: Hex) {
      const records = await client.getLogs({
        address,
        blockHash,
        event: filledEvent,
        strict: true,
      });
      return records.map(({ args, transactionHash }) => ({
        quoteHash: args.quoteHash,
        transactionHash,
      }));
    },
    async receipt(hash: Hex, wire: QuoteWire, commands: ForwardPayload[]) {
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
            deployment.contracts.ledgerForwarder.toLowerCase() &&
          matchesForwardCall(transaction.input, commands);
        const digest = hashQuote(domain, quoteTyped(wire));
        const filled = parseEventLogs({
          abi: [filledEvent],
          eventName: "Filled",
          logs: receipt.logs.filter(
            (log) => log.address.toLowerCase() === address.toLowerCase(),
          ),
          strict: true,
        }).some((log) => log.args.quoteHash === digest);
        return { ...receipt, matches, filled };
      } catch (error) {
        if (
          !(error instanceof TransactionNotFoundError) &&
          !(error instanceof TransactionReceiptNotFoundError)
        )
          throw error;
      }
    },
    finalizedRequest: transfers.finalizedRequest,
  };
}
