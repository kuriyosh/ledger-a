import {
  atomicSwapAbi,
  kycRegistryAbi,
  ledgerForwarderAbi,
  ledgerTokenAbi,
  travelRuleComplianceAbi,
} from "@ledgera/abis";
import {
  type Address,
  BaseError,
  decodeErrorResult,
  ExecutionRevertedError,
  getAddress,
  type Hex,
  isAddress,
  isHex,
  RpcRequestError,
  TransactionReceiptNotFoundError,
} from "viem";
import type { SequencerClient } from "./sequencer.ts";

const relayErrors = [
  ...kycRegistryAbi,
  ...ledgerForwarderAbi,
  ...ledgerTokenAbi,
  ...atomicSwapAbi,
  ...travelRuleComplianceAbi,
].filter((item) => item.type === "error");

type SimulationFailure = {
  reverted: true;
  revertData: Hex;
  errorName?: string;
  args?: Record<string, unknown>;
};
type Simulation = SimulationFailure | { reverted: false; estimatedGas: bigint };

export function simulationFailure(
  error: unknown,
): SimulationFailure | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const rpc = error.walk((cause) => cause instanceof RpcRequestError);
  const reverted = error.walk(
    (cause) => cause instanceof ExecutionRevertedError,
  );
  if (
    !(reverted instanceof ExecutionRevertedError) &&
    !(
      rpc instanceof RpcRequestError &&
      /execution reverted/i.test(rpc.details ?? "")
    )
  )
    return undefined;

  const raw = rpc instanceof RpcRequestError ? rpc.data : undefined;
  const nested =
    typeof raw === "object" && raw !== null && "data" in raw
      ? raw.data
      : undefined;
  const data = isHex(raw) ? raw : isHex(nested) ? nested : "0x";
  if (data === "0x") return { reverted: true, revertData: data };
  try {
    const decoded = decodeErrorResult({ abi: relayErrors, data });
    const args = Object.fromEntries(
      decoded.abiItem.inputs.map((input, index) => [
        input.name || String(index),
        decoded.args?.[index],
      ]),
    );
    const jsonArgs = JSON.parse(
      JSON.stringify(args, (_name, value) => {
        if (typeof value === "bigint") return value.toString();
        if (typeof value === "string" && isAddress(value, { strict: false }))
          return getAddress(value);
        return value;
      }),
    );
    return {
      reverted: true,
      revertData: data,
      errorName: decoded.errorName,
      args: jsonArgs,
    };
  } catch {
    return { reverted: true, revertData: data };
  }
}

export function relayChain(
  client: SequencerClient,
  registry: Address,
  forwarder: Address,
) {
  return {
    vaspOf(address: Address) {
      return client.readContract({
        address: registry,
        abi: kycRegistryAbi,
        functionName: "vaspOf",
        args: [address],
      });
    },
    forwarderNonce(address: Address) {
      return client.readContract({
        address: forwarder,
        abi: ledgerForwarderAbi,
        functionName: "nonces",
        args: [address],
        blockTag: "pending",
      });
    },
    async isReverted(hash: Hex) {
      try {
        return (
          (await client.getTransactionReceipt({ hash })).status === "reverted"
        );
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        return false;
      }
    },
    async simulate(relayer: Address, data: Hex): Promise<Simulation> {
      try {
        const estimatedGas = await client.estimateGas({
          account: relayer,
          to: forwarder,
          data,
          value: 0n,
          blockTag: "pending",
        });
        return { reverted: false, estimatedGas };
      } catch (error) {
        const failure = simulationFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  };
}
