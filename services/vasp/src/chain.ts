import { kycRegistryAbi, ledgerTokenAbi } from "@ledgera/abis";
import { type Deployment, defineLedgerChain } from "@ledgera/config";
import { ServiceError } from "@ledgera/shared/errors";
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  type Hex,
  http,
  type LocalAccount,
  TransactionReceiptNotFoundError,
  zeroHash,
} from "viem";
import { z } from "zod";
import type {
  RegistryAction,
  RegistryRequest,
  RegistryResult,
} from "./db/store.ts";

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
  "NONCE_TOO_LOW",
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

export function registryGateway(gatewayUrl: string) {
  async function request(path: string, init?: RequestInit) {
    try {
      const result = await fetch(new URL(path, gatewayUrl), {
        ...init,
        signal: AbortSignal.timeout(18_000),
      });
      if (!result.ok) throw gatewayUnavailable();
      return await result.json();
    } catch {
      throw gatewayUnavailable();
    }
  }
  return {
    async submit(pending: RegistryRequest): Promise<"accepted" | "rejected"> {
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
      if (detail?.reason && definiteRejection.has(detail.reason))
        return "rejected";
      if (detail?.receipt?.txHash === pending.txHash) return "accepted";
      if (detail?.reason === "DUPLICATE_TX") {
        const stored = gatewayReceipt.safeParse(
          await request(`/v1/receipts/${pending.txHash}`),
        );
        if (!stored.success || stored.data.txHash !== pending.txHash)
          throw gatewayUnavailable();
        const log = z
          .object({
            entries: z.array(
              z.object({ txHash: hexHash, forwardStatus: z.string() }),
            ),
          })
          .safeParse(
            await request(`/v1/log?fromSeq=${stored.data.seq}&limit=1`),
          );
        const match = log.success && log.data.entries[0];
        if (!match || match.txHash !== pending.txHash)
          throw gatewayUnavailable();
        return match.forwardStatus === "rejected" ? "rejected" : "accepted";
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
      let data: Hex;
      switch (action) {
        case "register":
          data = encodeFunctionData({
            abi: kycRegistryAbi,
            functionName: "registerAccount",
            args: [address, 1, BigInt(Math.floor(validUntil.getTime() / 1000))],
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
      const [nonce, gas, block] = await Promise.all([
        client.getTransactionCount({
          address: admin.address,
          blockTag: "pending",
        }),
        client.estimateGas({ account: admin.address, to: registry, data }),
        client.getBlock({ blockTag: "latest" }),
      ]);
      const minimumFee =
        2n * (block.baseFeePerGas ?? 0n) + registrationPriorityFee;
      return admin.signTransaction({
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
    },
    async receipt(hash: Hex) {
      try {
        return result(await client.getTransactionReceipt({ hash }));
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      }
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
