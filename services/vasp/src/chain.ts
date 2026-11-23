import { kycRegistryAbi, ledgerTokenAbi } from "@ledgera/abis";
import { type Deployment, defineLedgerChain } from "@ledgera/config";
import { ServiceError } from "@ledgera/shared/errors";
import { finalizedReplacement } from "@ledgera/shared/finalized-nonce";
import {
  type Address,
  BaseError,
  createPublicClient,
  ExecutionRevertedError,
  encodeFunctionData,
  type Hex,
  http,
  type LocalAccount,
  parseTransaction,
  TransactionReceiptNotFoundError,
  type TransactionSerialized,
  zeroHash,
} from "viem";
import type {
  RegistryAction,
  RegistryRequest,
  RegistryResult,
} from "./db/store.ts";

export { rawGateway as registryGateway } from "@ledgera/shared/raw-gateway";

const registrationPriorityFee = 1n;
const registrationFeeCap = 100_000_000_000n;
function result(receipt: {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
}): RegistryResult {
  return {
    success: receipt.status === "success",
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  };
}

export function registryChain(
  deployment: Deployment,
  rpcUrl: string,
  admin: LocalAccount,
) {
  const chain = defineLedgerChain(deployment.environment, {
    rpcUrl,
    devnetChainId: deployment.chainId,
  });
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { retryCount: 0, timeout: 5_000 }),
  });
  const registry = deployment.contracts.kycRegistry;

  return {
    client,
    vasp(id: number) {
      return client.readContract({
        address: registry,
        abi: kycRegistryAbi,
        functionName: "getVasp",
        args: [id],
      });
    },
    async build(action: RegistryAction, address: Address, validUntil: Date) {
      try {
        if (action !== "register") {
          const account = await client.readContract({
            address: registry,
            abi: kycRegistryAbi,
            functionName: "getAccount",
            args: [address],
          });
          if (account.status === (action === "suspend" ? 2 : 1))
            return undefined;
        }
        let data: Hex;
        switch (action) {
          case "register":
            data = encodeFunctionData({
              abi: kycRegistryAbi,
              functionName: "registerAccount",
              args: [
                address,
                1,
                BigInt(Math.floor(validUntil.getTime() / 1000)),
              ],
            });
            break;
          case "suspend":
            data = encodeFunctionData({
              abi: kycRegistryAbi,
              functionName: "suspendAccount",
              args: [address, zeroHash],
            });
            break;
          case "reinstate":
            data = encodeFunctionData({
              abi: kycRegistryAbi,
              functionName: "reinstateAccount",
              args: [address],
            });
            break;
        }
        const block = await client.getBlock({ blockTag: "latest" });
        const [nonce, gas] = await Promise.all([
          client.getTransactionCount({
            address: admin.address,
            blockTag: "pending",
          }),
          client.estimateGas({ account: admin.address, to: registry, data }),
        ]);
        const minimumFee =
          2n * (block.baseFeePerGas ?? 0n) + registrationPriorityFee;
        const rawTx = await admin.signTransaction({
          type: "eip1559",
          chainId: deployment.chainId,
          to: registry,
          data,
          nonce,
          gas: (13n * gas + 9n) / 10n,
          maxFeePerGas:
            minimumFee > registrationFeeCap ? minimumFee : registrationFeeCap,
          maxPriorityFeePerGas: registrationPriorityFee,
        });
        return { rawTx, firstBlock: block.number };
      } catch (error) {
        const revert =
          error instanceof BaseError &&
          error.walk(
            (cause) => cause instanceof ExecutionRevertedError,
          ) instanceof ExecutionRevertedError;
        throw new ServiceError(
          revert ? "REGISTRY_REJECTED" : "REGISTRY_UNAVAILABLE",
          revert
            ? "Registry rejected the proposed operation"
            : "Registry RPC is unavailable",
          revert ? 422 : 503,
        );
      }
    },
    async receipt(hash: Hex) {
      try {
        return result(await client.getTransactionReceipt({ hash }));
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      }
    },
    async replaced(request: RegistryRequest) {
      const nonce = parseTransaction(
        request.rawTx as TransactionSerialized,
      ).nonce;
      if (nonce === undefined)
        throw new Error("Stored Registry transaction has no nonce");
      return finalizedReplacement(
        {
          finalized: () =>
            client.getBlock({
              blockTag: "finalized",
              includeTransactions: true,
            }),
          body: (blockHash) =>
            client.getBlock({ blockHash, includeTransactions: true }),
          async hashAt(blockNumber) {
            return (await client.getBlock({ blockNumber })).hash;
          },
          countAt: (blockHash) =>
            client.getTransactionCount({
              address: admin.address,
              blockHash,
              requireCanonical: true,
            }),
        },
        {
          sender: admin.address,
          nonce,
          txHash: request.txHash,
          firstBlock: request.firstBlock ?? BigInt(deployment.auditStartBlock),
        },
      );
    },
    async wait(hash: Hex) {
      return result(
        await client.waitForTransactionReceipt({
          hash,
          timeout: 18_000,
          pollingInterval: 500,
          checkReplacement: false,
        }),
      );
    },
    async balances(address: Address) {
      const read = (token: Address) =>
        client.readContract({
          address: token,
          abi: ledgerTokenAbi,
          functionName: "balanceOf",
          args: [address],
        });
      const [jpy, usd] = await Promise.all([
        read(deployment.contracts.tJPY),
        read(deployment.contracts.tUSD),
      ]);
      return { tJPY: jpy.toString(), tUSD: usd.toString() };
    },
  };
}
