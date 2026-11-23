import { consortiumSafeAbi, kycRegistryAbi } from "@ledgera/abis";
import { type Deployment, defineLedgerChain } from "@ledgera/config";
import { ServiceError } from "@ledgera/shared/errors";
import { finalizedReplacement } from "@ledgera/shared/finalized-nonce";
import {
  type Address,
  BaseError,
  concatHex,
  createPublicClient,
  ExecutionRevertedError,
  encodeFunctionData,
  getAbiItem,
  type Hex,
  http,
  keccak256,
  type LocalAccount,
  padHex,
  parseEventLogs,
  parseTransaction,
  TransactionReceiptNotFoundError,
  type TransactionSerialized,
  zeroAddress,
  zeroHash,
} from "viem";

const abi = consortiumSafeAbi;
const approveEvent = getAbiItem({ abi, name: "ApproveHash" });
const executionEvent = getAbiItem({ abi, name: "ExecutionSuccess" });
const fixedPriority = 1n;
const minimumFee = 100_000_000_000n;
const logSpan = 1_000n;
const revertGas = 750_000n;

export type SafeCall = { to: Address; data: Hex };
export type MemberId = 1 | 2 | 3;
export type Member = { id: MemberId; name: string; account: LocalAccount };
export type Approval = {
  memberId: MemberId;
  address: Address;
  txHash: Hex;
  blockNumber: bigint;
  approvedAt: Date;
};

export function safeSignatures(approved: readonly Address[]) {
  const sorted = approved
    .map((address) => address.toLowerCase() as Address)
    .sort();
  return concatHex(
    sorted.map((owner) => concatHex([padHex(owner), zeroHash, "0x01"])),
  );
}

function args({ to, data }: SafeCall) {
  return [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress] as const;
}

export function consortiumChain(
  deployment: Deployment,
  rpcUrl: string,
  members: readonly Member[],
) {
  const address = deployment.contracts.consortiumSafe;
  const client = createPublicClient({
    chain: defineLedgerChain(deployment.environment, {
      rpcUrl,
      devnetChainId: deployment.chainId,
    }),
    transport: http(rpcUrl, { timeout: 5_000, retryCount: 0 }),
    cacheTime: 0,
  });
  const safe = { address, abi };
  const unavailable = () =>
    new ServiceError(
      "SAFE_UNAVAILABLE",
      "Could not verify current Safe state",
      503,
    );

  async function snapshot() {
    const block = await client.getBlock({ blockTag: "latest" });
    const at = { ...safe, blockNumber: block.number };
    const [nonce, threshold, owners] = await Promise.all([
      client.readContract({ ...at, functionName: "nonce" }),
      client.readContract({ ...at, functionName: "getThreshold" }),
      client.readContract({ ...at, functionName: "getOwners" }),
    ]);
    const configured = new Set(
      members.map((member) => member.account.address.toLowerCase()),
    );
    if (
      configured.size !== members.length ||
      owners.length !== configured.size ||
      owners.some((owner) => !configured.has(owner.toLowerCase())) ||
      threshold < 2n ||
      threshold > BigInt(owners.length)
    )
      throw unavailable();
    return { address, block, nonce, threshold: Number(threshold), owners };
  }

  async function verifyAnchor(block: { number: bigint; hash: Hex }) {
    if (
      (await client.getBlock({ blockNumber: block.number })).hash !== block.hash
    )
      throw unavailable();
  }

  async function receipt(hash: Hex) {
    try {
      const result = await client.getTransactionReceipt({ hash });
      const canonical = await client.getBlock({
        blockNumber: result.blockNumber,
      });
      if (canonical.hash === result.blockHash) return result;
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
  }

  async function sign(account: LocalAccount, data: Hex, execution: boolean) {
    const block = await client.getBlock({ blockTag: "latest" });
    const [nonce, gas] = await Promise.all([
      client.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      }),
      client
        .estimateGas({ account: account.address, to: address, data })
        .catch((error: unknown) => {
          if (
            execution &&
            error instanceof BaseError &&
            error.walk(
              (cause) => cause instanceof ExecutionRevertedError,
            ) instanceof ExecutionRevertedError
          )
            return revertGas;
          throw error;
        }),
    ]);
    const currentFee = 2n * (block.baseFeePerGas ?? 0n) + fixedPriority;
    const rawTx = await account.signTransaction({
      type: "eip1559",
      chainId: deployment.chainId,
      nonce,
      to: address,
      data,
      gas: (13n * gas + 9n) / 10n,
      maxFeePerGas: currentFee > minimumFee ? currentFee : minimumFee,
      maxPriorityFeePerGas: fixedPriority,
    });
    return { rawTx, txHash: keccak256(rawTx), firstBlock: block.number };
  }

  return {
    address,
    async verify() {
      if ((await client.getChainId()) !== deployment.chainId)
        throw unavailable();
      const { block } = await snapshot();
      await verifyAnchor(block);
    },
    async overview() {
      const { block, ...overview } = await snapshot();
      await verifyAnchor(block);
      return overview;
    },
    async executionIsFinal(position: { blockNumber: bigint; blockHash: Hex }) {
      const finalized = await client.getBlock({ blockTag: "finalized" });
      return (
        position.blockNumber <= finalized.number &&
        (await client.getBlock({ blockNumber: position.blockNumber })).hash ===
          position.blockHash
      );
    },
    async vasp(id: number) {
      const entry = await client.readContract({
        address: deployment.contracts.kycRegistry,
        abi: kycRegistryAbi,
        functionName: "getVasp",
        args: [id],
      });
      return { active: entry.status === 1, signer: entry.travelRuleSigner };
    },
    async identify(call: SafeCall) {
      const { block, nonce } = await snapshot();
      const hash = await client.readContract({
        ...safe,
        functionName: "getTransactionHash",
        args: [...args(call), nonce],
        blockNumber: block.number,
      });
      await verifyAnchor(block);
      return { safeTxHash: hash, safeNonce: nonce, firstBlock: block.number };
    },
    async observe(
      safeTxHash: Hex,
      expectedNonce: bigint,
      firstBlock: bigint,
      hints: { approvals: readonly Approval[]; executedTxHash: Hex | null },
    ) {
      const { block, nonce, threshold } = await snapshot();
      const approvalRecords = new Map<MemberId, Approval>();
      type Position = { txHash: Hex; blockNumber: bigint; blockHash: Hex };
      let executed: Position | undefined;

      const approvalsOnchain = await Promise.all(
        members.map((member) =>
          client.readContract({
            ...safe,
            functionName: "approvedHashes",
            args: [member.account.address, safeTxHash],
            blockNumber: block.number,
          }),
        ),
      );
      const approvedMembers = members.filter(
        (_, index) => approvalsOnchain[index] !== 0n,
      );

      async function remember(approved: Member, position: Position) {
        const source = await client.getBlock({
          blockNumber: position.blockNumber,
        });
        if (source.hash !== position.blockHash) throw unavailable();
        approvalRecords.set(approved.id, {
          memberId: approved.id,
          address: approved.account.address,
          txHash: position.txHash,
          blockNumber: position.blockNumber,
          approvedAt: new Date(Number(source.timestamp) * 1_000),
        });
      }

      await Promise.all(
        approvedMembers.map(async (approved) => {
          const prior = hints.approvals.find(
            (item) => item.memberId === approved.id,
          );
          if (!prior) return;
          const item = await receipt(prior.txHash);
          if (!item || item.blockNumber > block.number) return;
          const log = parseEventLogs({
            abi: [approveEvent],
            eventName: "ApproveHash",
            logs: item.logs.filter(
              (entry) => entry.address.toLowerCase() === address.toLowerCase(),
            ),
            strict: true,
          }).find(
            ({ args }) =>
              args.approvedHash === safeTxHash &&
              args.owner.toLowerCase() ===
                approved.account.address.toLowerCase(),
          );
          if (log)
            await remember(approved, {
              txHash: prior.txHash,
              blockNumber: item.blockNumber,
              blockHash: item.blockHash,
            });
        }),
      );

      if (nonce > expectedNonce && hints.executedTxHash) {
        const item = await receipt(hints.executedTxHash);
        if (
          item &&
          item.blockNumber <= block.number &&
          parseEventLogs({
            abi: [executionEvent],
            eventName: "ExecutionSuccess",
            logs: item.logs.filter(
              (entry) => entry.address.toLowerCase() === address.toLowerCase(),
            ),
            strict: true,
          }).some(({ args }) => args.txHash === safeTxHash)
        )
          executed = {
            txHash: item.transactionHash,
            blockNumber: item.blockNumber,
            blockHash: item.blockHash,
          };
      }

      async function scan(floor: bigint, ceiling: bigint, executions: boolean) {
        for (
          let fromBlock = floor;
          fromBlock <= ceiling;
          fromBlock += logSpan
        ) {
          const end = fromBlock + logSpan - 1n;
          const toBlock = end < ceiling ? end : ceiling;
          const missing = approvedMembers.filter(
            ({ id }) => !approvalRecords.has(id),
          );
          if (
            missing.length === 0 &&
            (!executions || nonce <= expectedNonce || executed)
          )
            break;
          if (missing.length > 0) {
            const logs = await client.getLogs({
              address,
              event: approveEvent,
              args: {
                approvedHash: safeTxHash,
                owner: missing.map(({ account }) => account.address),
              },
              fromBlock,
              toBlock,
              strict: true,
            });
            for (const log of logs) {
              const owner = missing.find(
                ({ account }) =>
                  account.address.toLowerCase() ===
                  log.args.owner.toLowerCase(),
              );
              if (owner && !approvalRecords.has(owner.id))
                await remember(owner, {
                  txHash: log.transactionHash,
                  blockNumber: log.blockNumber,
                  blockHash: log.blockHash,
                });
            }
          }
          if (executions && nonce > expectedNonce && !executed) {
            const logs = await client.getLogs({
              address,
              event: executionEvent,
              fromBlock,
              toBlock,
              strict: true,
            });
            const event = logs.find((log) => log.args.txHash === safeTxHash);
            if (event) {
              if (
                (await client.getBlock({ blockNumber: event.blockNumber }))
                  .hash !== event.blockHash
              )
                throw unavailable();
              executed = {
                txHash: event.transactionHash,
                blockNumber: event.blockNumber,
                blockHash: event.blockHash,
              };
            }
          }
        }
      }

      await scan(firstBlock, block.number, true);
      if (approvalRecords.size !== approvedMembers.length) {
        await scan(BigInt(deployment.auditStartBlock), firstBlock - 1n, false);
        if (approvalRecords.size !== approvedMembers.length)
          throw unavailable();
      }
      await verifyAnchor(block);
      return {
        nonce,
        threshold,
        approvals: [...approvalRecords.values()],
        executed,
      };
    },
    approve(member: Member, hash: Hex) {
      return sign(
        member.account,
        encodeFunctionData({ abi, functionName: "approveHash", args: [hash] }),
        false,
      );
    },
    execute(member: Member, call: SafeCall, approved: readonly Address[]) {
      return sign(
        member.account,
        encodeFunctionData({
          abi,
          functionName: "execTransaction",
          args: [...args(call), safeSignatures(approved)],
        }),
        true,
      );
    },
    async wait(hash: Hex) {
      await client.waitForTransactionReceipt({
        hash,
        timeout: 15_000,
        pollingInterval: 250,
        checkReplacement: false,
      });
      return receipt(hash);
    },
    replaced(
      member: Member,
      request: { rawTx: Hex; txHash: Hex; firstBlock: bigint },
    ) {
      const nonce = parseTransaction(
        request.rawTx as TransactionSerialized,
      ).nonce;
      if (nonce === undefined)
        throw new Error("Stored Safe action has no nonce");
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
              address: member.account.address,
              blockHash,
              requireCanonical: true,
            }),
        },
        {
          sender: member.account.address,
          nonce,
          txHash: request.txHash,
          firstBlock: request.firstBlock,
        },
      );
    },
    receipt,
  };
}
