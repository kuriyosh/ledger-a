import { depositProbeAbi, kycRegistryAbi, ledgerTokenAbi } from "@ledgera/abis";
import { type Deployment, defineLedgerChain } from "@ledgera/config";
import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { desc, eq } from "drizzle-orm";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  type Hash,
  http,
  keccak256,
  parseAbi,
  parseEther,
  TransactionReceiptNotFoundError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { getL2TransactionHashes } from "viem/op-stack";
import { z } from "zod";
import { deposits } from "./db/schema.ts";
import { exclusive } from "./mint.ts";

const actions = ["token-transfer", "eth-transfer", "deploy"] as const;
type Action = (typeof actions)[number];
export const depositInput = z.strictObject({
  mintEth: z.literal("0.001"),
  action: z.enum(["probe", "none"]),
});
export const enforcementInput = z.strictObject({
  route: z.enum(["direct", "gateway"]),
  action: z.enum(actions),
});
export const depositHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hash);
const portalAbi = parseAbi([
  "function depositTransaction(address to, uint256 value, uint64 gasLimit, bool isCreation, bytes data) payable",
]);
const gas = {
  "token-transfer": 100_000n,
  "eth-transfer": 100_000n,
  deploy: 200_000n,
};
const valueFor = (action: Action) => (action === "eth-transfer" ? 1n : 0n);
type Devnet = Extract<Deployment, { environment: "devnet" }>;
type Database = Awaited<ReturnType<typeof openDatabase>>;

export function enforcementDemo(
  database: Database,
  deployment: Devnet,
  urls: { l1: string; l2: string; direct: string; gateway: string },
  key: Hash,
  maxFeePerGas: bigint,
) {
  const account = privateKeyToAccount(key);
  const transport = (url: string) =>
    http(url, {
      timeout: 8_000,
      retryCount: 0,
      fetchOptions: { redirect: "error" },
    });
  const chain = defineLedgerChain("devnet", {
    rpcUrl: urls.l2,
    devnetChainId: deployment.chainId,
  });
  const l2 = createPublicClient({ chain, transport: transport(urls.l2) });
  const direct = createPublicClient({
    chain,
    transport: transport(urls.direct),
  });
  const l1 = createPublicClient({
    chain: sepolia,
    transport: transport(urls.l1),
  });
  const wallet = createWalletClient({
    chain: sepolia,
    account,
    transport: transport(urls.l1),
  });
  const { kycRegistry, depositProbe, tUSD } = deployment.contracts;
  const amount = (action: Action) =>
    gas[action] * maxFeePerGas + valueFor(action);
  const target = { address: kycRegistry, abi: kycRegistryAbi } as const;
  const probe = () =>
    l2.readContract({
      address: depositProbe,
      abi: depositProbeAbi,
      functionName: "count",
      args: [account.address],
    });

  async function status() {
    const [registry, enforced, balance, head, probeCount, l1Balance] =
      await Promise.all([
        l2.readContract({
          ...target,
          functionName: "getAccount",
          args: [account.address],
        }),
        l2.readContract({ ...target, functionName: "enforcementEnabled" }),
        l2.getBalance({ address: account.address }),
        l2.getBlock({ blockTag: "latest" }),
        probe(),
        l1.getBalance({ address: account.address }),
      ]);
    const minFee = (head.baseFeePerGas ?? 0n) * 2n + 1n;
    return {
      address: account.address,
      registryStatus: registry.status,
      enforcementEnabled: enforced,
      l1BalanceWei: l1Balance.toString(),
      l2BalanceWei: balance.toString(),
      probeCount: probeCount.toString(),
      maxFeePerGasWei: maxFeePerGas.toString(),
      minFeePerGasWei: minFee.toString(),
      requiredWei: Object.fromEntries(
        actions.map((action) => [action, amount(action).toString()]),
      ),
    };
  }

  async function unregistered() {
    const [id, state] = await Promise.all([l2.getChainId(), status()]);
    if (
      id !== deployment.chainId ||
      !state.enforcementEnabled ||
      state.registryStatus !== 0
    )
      throw new ServiceError(
        "ENFORCEMENT_DEMO_UNAVAILABLE",
        "The configured demo account must be unregistered on the enforced DevNet",
        409,
      );
    return state;
  }

  async function readDeposit(hash: Hash) {
    const [row] = await database.db
      .select()
      .from(deposits)
      .where(eq(deposits.hash, hash));
    if (!row)
      throw new ServiceError(
        "DEPOSIT_NOT_FOUND",
        "Demo deposit not found",
        404,
      );
    const receipt = await l1.getTransactionReceipt({ hash }).catch((error) => {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      return undefined;
    });
    const l1Status = !receipt
      ? "pending"
      : receipt.status === "success"
        ? "confirmed"
        : "failed";
    const [l2Hash] = getL2TransactionHashes({
      logs:
        receipt?.logs.filter(
          (log) =>
            log.address.toLowerCase() ===
            deployment.l1.optimismPortal.toLowerCase(),
        ) ?? [],
    });
    const arrived =
      l2Hash &&
      (await l2.getTransactionReceipt({ hash: l2Hash }).catch((error) => {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        return undefined;
      }));
    const [l2Balance, currentProbe] = await Promise.all([
      l2.getBalance({ address: account.address }),
      probe(),
    ]);
    return {
      l1TxHash: hash,
      l1Status,
      l2TxHash: l2Hash ?? null,
      l2Status: arrived
        ? arrived.status === "success"
          ? "success"
          : "failed"
        : "pending",
      l2BalanceWei: l2Balance.toString(),
      probeCountBefore: row.probeBefore,
      probeCountAfter: currentProbe.toString(),
    };
  }

  async function startDeposit(input: z.infer<typeof depositInput>, id: string) {
    return exclusive(database, "enforcement-demo:deposit", async () => {
      const [old] = await database.db
        .select()
        .from(deposits)
        .where(eq(deposits.id, id));
      if (old && old.action !== input.action)
        throw new ServiceError(
          "IDEMPOTENCY_CONFLICT",
          "Deposit parameters changed",
          409,
        );
      if (old) {
        const view = await readDeposit(old.hash as Hash);
        if (view.l1Status !== "pending") return view;
      } else {
        const [last] = await database.db
          .select()
          .from(deposits)
          .orderBy(desc(deposits.createdAt))
          .limit(1);
        if (
          last &&
          (await readDeposit(last.hash as Hash)).l1Status === "pending"
        )
          throw new ServiceError(
            "DEMO_OPERATION_IN_PROGRESS",
            "A prior L1 deposit is awaiting confirmation",
            409,
          );
      }
      const state = await unregistered();
      if ((await l1.getChainId()) !== deployment.l1.chainId)
        throw new ServiceError(
          "ENFORCEMENT_DEMO_UNAVAILABLE",
          "The L1 RPC did not report Sepolia",
          409,
        );
      let pending = old;
      if (!pending) {
        const l1Gas = 450_000n;
        const mint = parseEther(input.mintEth);
        const request = await wallet.prepareTransactionRequest({
          to: deployment.l1.optimismPortal,
          type: "eip1559",
          gas: l1Gas,
          data: encodeFunctionData({
            abi: portalAbi,
            functionName: "depositTransaction",
            args: [
              input.action === "probe" ? depositProbe : account.address,
              0n,
              200_000n,
              false,
              input.action === "probe"
                ? encodeFunctionData({
                    abi: depositProbeAbi,
                    functionName: "poke",
                  })
                : "0x",
            ],
          }),
          value: mint,
        });
        if (BigInt(state.l1BalanceWei) < l1Gas * request.maxFeePerGas + mint)
          throw new ServiceError(
            "ATTACKER_NOT_READY",
            "The demo account does not have enough Sepolia ETH",
            409,
          );
        const rawTx = await wallet.signTransaction(request);
        [pending] = await database.db
          .insert(deposits)
          .values({
            id,
            action: input.action,
            hash: keccak256(rawTx),
            rawTx,
            probeBefore: state.probeCount,
          })
          .returning();
      }
      if (!pending) throw new Error("Unable to store the demo deposit");
      const prepared = pending;
      await l1
        .sendRawTransaction({ serializedTransaction: prepared.rawTx as Hash })
        .then((hash) => {
          if (hash !== prepared.hash)
            throw new Error("L1 returned a different transaction hash");
        })
        .catch(async () => {
          const known = await l1
            .getTransaction({ hash: pending.hash as Hash })
            .catch(() => undefined);
          if (!known)
            throw new ServiceError(
              "L1_SUBMISSION_UNCERTAIN",
              "The L1 RPC did not confirm submission. Retry the same request.",
              503,
            );
        });
      return readDeposit(pending.hash as Hash);
    });
  }

  async function send(input: z.infer<typeof enforcementInput>) {
    const state = await unregistered();
    const selected = input.route === "direct" ? direct : l2;
    if ((await selected.getChainId()) !== deployment.chainId)
      throw new ServiceError(
        "ENFORCEMENT_DEMO_UNAVAILABLE",
        "The execution RPC did not report the configured DevNet",
        409,
      );
    if (
      BigInt(state.l2BalanceWei) < amount(input.action) ||
      maxFeePerGas < BigInt(state.minFeePerGasWei)
    )
      throw new ServiceError(
        "ATTACKER_NOT_READY",
        "The demo account balance or fee cap is insufficient",
        409,
        {
          balanceWei: state.l2BalanceWei,
          requiredWei: amount(input.action).toString(),
          maxFeePerGasWei: state.maxFeePerGasWei,
          minFeePerGasWei: state.minFeePerGasWei,
        },
      );
    const rawTx = await account.signTransaction({
      type: "eip1559",
      chainId: deployment.chainId,
      nonce: await selected.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      }),
      gas: gas[input.action],
      maxFeePerGas,
      maxPriorityFeePerGas: 1n,
      value: valueFor(input.action),
      to:
        input.action === "deploy"
          ? undefined
          : input.action === "token-transfer"
            ? tUSD
            : account.address,
      data:
        input.action === "token-transfer"
          ? encodeFunctionData({
              abi: ledgerTokenAbi,
              functionName: "transfer",
              args: [account.address, 1_000_000n],
            })
          : input.action === "deploy"
            ? "0x60006000f3"
            : "0x",
    });
    const targetUrl =
      input.route === "direct" ? urls.direct : new URL("/rpc", urls.gateway);
    const result = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [rawTx],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(18_000),
    });
    const response = z
      .union([
        z.object({
          result: z.union([depositHash, z.object({ txHash: depositHash })]),
        }),
        z.object({
          error: z.object({
            code: z.int(),
            message: z.string(),
            data: z.object({ reason: z.string().optional() }).optional(),
          }),
        }),
      ])
      .safeParse(await result.json());
    if (!response.success)
      throw new ServiceError(
        "ENFORCEMENT_RPC_UNAVAILABLE",
        "The demo RPC did not return a transaction result",
        503,
      );
    const txHash = keccak256(rawTx);
    if ("result" in response.data) return { accepted: true, txHash };
    const { code, message, data } = response.data.error;
    return {
      accepted: false,
      txHash,
      error: {
        code,
        message:
          data?.reason === "SENDER_NOT_ALLOWED"
            ? `ledgera: sender not allowed: ${account.address}`
            : message,
      },
    };
  }
  async function latestDeposit() {
    const [row] = await database.db
      .select()
      .from(deposits)
      .orderBy(desc(deposits.createdAt))
      .limit(1);
    return row ? readDeposit(row.hash as Hash) : null;
  }
  return { status, startDeposit, readDeposit, latestDeposit, send };
}
