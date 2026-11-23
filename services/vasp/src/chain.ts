import { kycRegistryAbi, ledgerTokenAbi } from "@ledgera/abis";
import { type Deployment, defineLedgerChain } from "@ledgera/config";
import { ServiceError } from "@ledgera/shared/errors";
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
import { z } from "zod";
import type {
  RegistryAction,
  RegistryRequest,
  RegistryResult,
} from "./db/store.ts";
import { finalizedReplacement } from "./finalized-nonce.ts";

const registrationPriorityFee = 1n;
const registrationFeeCap = 100_000_000_000n;
const hexHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
const gatewayReceipt = z.object({
  seq: z.string().regex(/^\d{1,20}$/),
  txHash: hexHash,
});
const gatewayReply = z.union([
  z.object({ result: z.object({ txHash: hexHash, receipt: gatewayReceipt }) }),
  z.object({
    error: z.object({
      data: z
        .object({
          reason: z.string().optional(),
          receipt: gatewayReceipt.optional(),
        })
        .optional(),
    }),
  }),
]);
const definiteRejection = new Set([
  "INVALID_TX",
  "UNSUPPORTED_TX_TYPE",
  "WRONG_CHAIN_ID",
  "PRIORITY_FEE_NOT_FIXED",
  "MAX_FEE_TOO_LOW",
  "GAS_LIMIT_TOO_HIGH",
  "NONCE_GAP",
  "INSUFFICIENT_FUNDS",
  "SENDER_NOT_ALLOWED",
  "FORWARD_REJECTED",
]);

function gatewayUnavailable() {
  return new ServiceError(
    "GATEWAY_UNAVAILABLE",
    "Gateway could not confirm the transaction",
    503,
  );
}

export function registryGateway(gatewayUrl: string, requestHttp = fetch) {
  async function request(
    path: string,
    init?: RequestInit,
    allowMissing = false,
  ) {
    try {
      const result = await requestHttp(new URL(path, gatewayUrl), {
        ...init,
        signal: AbortSignal.timeout(18_000),
      });
      if (allowMissing && result.status === 404) return undefined;
      if (!result.ok) throw gatewayUnavailable();
      return await result.json();
    } catch {
      throw gatewayUnavailable();
    }
  }
  async function statusOf(hash: Hex) {
    const body = await request(`/v1/receipts/${hash}`, undefined, true);
    if (body === undefined) return "missing" as const;
    const stored = gatewayReceipt.safeParse(body);
    if (!stored.success || stored.data.txHash !== hash)
      throw gatewayUnavailable();
    const log = z
      .object({
        entries: z.array(
          z.object({ txHash: hexHash, forwardStatus: z.string() }),
        ),
      })
      .safeParse(await request(`/v1/log?fromSeq=${stored.data.seq}&limit=1`));
    const match = log.success && log.data.entries[0];
    if (!match || match.txHash !== hash) throw gatewayUnavailable();
    return match.forwardStatus === "rejected"
      ? ("rejected" as const)
      : ("accepted" as const);
  }

  return {
    async submit(
      pending: RegistryRequest,
    ): Promise<"accepted" | "rejected" | "nonce_used"> {
      const response = gatewayReply.safeParse(
        await request("/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: pending.txHash,
            method: "ledgera_sendRawTransaction",
            params: [pending.rawTx],
          }),
        }),
      );
      if (!response.success) throw gatewayUnavailable();
      if ("result" in response.data) {
        if (
          response.data.result.txHash !== pending.txHash ||
          response.data.result.receipt.txHash !== pending.txHash
        ) {
          throw gatewayUnavailable();
        }
        return "accepted";
      }
      const detail = response.data.error.data;
      const reason = detail?.reason;
      if (
        detail?.receipt?.txHash === pending.txHash &&
        reason !== "FORWARD_REJECTED"
      )
        return "accepted";
      if (reason === "NONCE_TOO_LOW") return "nonce_used";
      if (
        reason === "DUPLICATE_TX" ||
        (reason && definiteRejection.has(reason))
      ) {
        const recorded = await statusOf(pending.txHash);
        if (recorded !== "missing") return recorded;
        if (reason !== "DUPLICATE_TX" && reason !== "FORWARD_REJECTED")
          return "rejected";
      }
      throw gatewayUnavailable();
    },
  };
}

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
