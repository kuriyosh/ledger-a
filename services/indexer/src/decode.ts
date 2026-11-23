import {
  atomicSwapAbi,
  consortiumSafeAbi,
  depositProbeAbi,
  kycRegistryAbi,
  ledgerForwarderAbi,
  ledgerTokenAbi,
  receiptLogAbi,
  travelRuleComplianceAbi,
} from "@ledgera/abis";
import type { Deployment } from "@ledgera/config";
import {
  type Abi,
  type AbiParameter,
  type Address,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionData,
  getAbiItem,
  type Hex,
  toFunctionSelector,
  zeroAddress,
} from "viem";
export type DecodableTransaction = {
  type: number;
  from: Address;
  to: Address | null;
  input: Hex;
  logs: ReadonlyArray<{
    address: Address;
    topics: Hex[];
    data: Hex;
    logIndex: number;
  }>;
};

type ParametersByName = Record<string, unknown>;
type Contract = keyof Deployment["contracts"];
type FunctionCall = {
  contract: Contract;
  function: string;
  args: ParametersByName;
  mutates: boolean;
};
type Call = FunctionCall & {
  inner?: Array<{
    signer: Address;
    to: Address;
    contract?: Contract;
    function?: string;
    args?: ParametersByName;
    mutates?: boolean;
  }>;
};
export type Event = {
  contract: Contract;
  name: string;
  args: ParametersByName;
  logIndex: number;
};

const abis: Record<Contract, Abi> = {
  atomicSwap: atomicSwapAbi,
  consortiumSafe: consortiumSafeAbi,
  depositProbe: depositProbeAbi,
  kycRegistry: kycRegistryAbi,
  ledgerForwarder: ledgerForwarderAbi,
  receiptLog: receiptLogAbi,
  tJPY: ledgerTokenAbi,
  tUSD: ledgerTokenAbi,
  travelRuleCompliance: travelRuleComplianceAbi,
};

const labels: Record<Contract, string> = {
  atomicSwap: "AtomicSwap",
  consortiumSafe: "ConsortiumSafe",
  depositProbe: "DepositProbe",
  kycRegistry: "KycRegistry",
  ledgerForwarder: "LedgerForwarder",
  receiptLog: "ReceiptLog",
  tJPY: "tJPY",
  tUSD: "tUSD",
  travelRuleCompliance: "TravelRuleCompliance",
};

const l1Block = "0x4200000000000000000000000000000000000015";
const l1AttributesDepositor = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001";

function json(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, json(entry)]),
    );
  return value;
}

function named(inputs: readonly AbiParameter[], values: readonly unknown[]) {
  return Object.fromEntries(
    inputs.map((input, index) => [
      input.name || String(index),
      json(values[index]),
    ]),
  );
}

export function isToken(contract: Contract): contract is "tJPY" | "tUSD" {
  return contract === "tJPY" || contract === "tUSD";
}

function kind(
  transaction: Pick<DecodableTransaction, "type" | "from" | "to">,
  call: Call | undefined,
  events: Event[],
) {
  if (transaction.type === 126)
    return transaction.to === l1Block &&
      transaction.from === l1AttributesDepositor
      ? "L1_ATTRIBUTES"
      : "DEPOSIT";
  if (transaction.to === null) return "CONTRACT_DEPLOY";
  if (call?.contract === "consortiumSafe") {
    if (call.function === "approveHash") return "SAFE_APPROVE";
    if (call.function === "execTransaction") return "SAFE_EXECUTE";
  }
  const calls = call?.inner ?? (call ? [call] : []);
  if (
    calls.some(
      (item) => item.contract === "atomicSwap" && item.function === "fill",
    ) ||
    events.some(
      (item) => item.contract === "atomicSwap" && item.name === "Filled",
    )
  )
    return "SWAP";
  if (
    events.some((item) => item.contract === "kycRegistry") ||
    calls.some((item) => item.contract === "kycRegistry" && item.mutates)
  )
    return "REGISTRY_UPDATE";
  if (
    calls.some(
      (item) => item.contract === "receiptLog" && item.function === "commit",
    ) ||
    events.some(
      (item) => item.contract === "receiptLog" && item.name === "Committed",
    )
  )
    return "RECEIPT_COMMIT";
  for (const item of calls) {
    if (!item.contract || !isToken(item.contract)) continue;
    if (item.function === "mint") return "TOKEN_MINT";
    if (item.function === "burn") return "TOKEN_BURN";
    if (
      item.function === "transfer" ||
      item.function === "transferWithTravelRule" ||
      item.function === "transferFrom" ||
      item.function === "forcedTransfer"
    )
      return "TOKEN_TRANSFER";
  }
  const transfer = events.find(
    (item) => isToken(item.contract) && item.name === "Transfer",
  );
  if (transfer) {
    if (transfer.args.from === zeroAddress) return "TOKEN_MINT";
    if (transfer.args.to === zeroAddress) return "TOKEN_BURN";
    return "TOKEN_TRANSFER";
  }
  return "OTHER";
}

export function decoder(contracts: Deployment["contracts"]) {
  const byAddress = new Map(
    (Object.entries(contracts) as [Contract, Address][]).map(
      ([contract, address]) => [address.toLowerCase(), contract],
    ),
  );

  function functionCall(contract: Contract, data: Hex) {
    const abi = abis[contract];
    const item = abi.find(
      (item) =>
        item.type === "function" &&
        toFunctionSelector(item) === data.slice(0, 10),
    );
    if (item?.type !== "function") return undefined;
    try {
      const decoded = decodeFunctionData({ abi: [item], data });
      return {
        contract,
        function: decoded.functionName,
        args: named(item.inputs, decoded.args ?? []),
        mutates:
          item.stateMutability !== "pure" && item.stateMutability !== "view",
      };
    } catch {
      return undefined;
    }
  }

  return (transaction: DecodableTransaction) => {
    const contract =
      transaction.to && byAddress.get(transaction.to.toLowerCase());
    const call: Call | undefined = contract
      ? functionCall(contract, transaction.input)
      : undefined;
    if (
      call?.contract === "ledgerForwarder" &&
      (call.function === "execute" ||
        call.function === "executeAll" ||
        call.function === "executeBatch")
    ) {
      const requests = (
        call.function === "execute" ? [call.args.request] : call.args.requests
      ) as Array<{
        from: Address;
        to: Address;
        data: Hex;
      }>;
      call.inner = requests.map((request) => {
        const target = byAddress.get(request.to.toLowerCase());
        return {
          signer: request.from,
          to: request.to,
          ...(target && {
            contract: target,
            ...functionCall(target, request.data),
          }),
        };
      });
    }
    const events = transaction.logs.flatMap((log): Event[] => {
      const source = byAddress.get(log.address.toLowerCase());
      if (!source || !log.topics[0]) return [];
      const abi = abis[source];
      const item = getAbiItem({ abi, name: log.topics[0] });
      if (item?.type !== "event") return [];
      try {
        const decoded = decodeEventLog({
          abi: [item],
          data: log.data,
          topics: [log.topics[0], ...log.topics.slice(1)],
        });
        const args = Array.isArray(decoded.args)
          ? named(item.inputs, decoded.args)
          : (json(decoded.args ?? {}) as ParametersByName);
        return [
          {
            contract: source,
            name: decoded.eventName,
            args,
            logIndex: log.logIndex,
          },
        ];
      } catch (error) {
        throw new Error(
          `Could not decode ${source}.${item.name} at log ${log.logIndex}`,
          { cause: error },
        );
      }
    });
    const displayed = call && {
      contract: labels[call.contract],
      function: call.function,
      args: call.args,
      ...(call.inner && {
        inner: call.inner.map((item) => ({
          signer: item.signer,
          to: item.to,
          contract: item.contract && labels[item.contract],
          function: item.function,
          args: item.args,
        })),
      }),
    };
    return { call: displayed, events, kind: kind(transaction, call, events) };
  };
}

export function errorDecoder(contracts: Deployment["contracts"]) {
  const byAddress = new Map(
    (Object.entries(contracts) as [Contract, Address][]).map(
      ([contract, address]) => [address.toLowerCase(), abis[contract]],
    ),
  );
  const all = Object.values(abis).flat();
  return (target: Address | undefined, data: Hex) => {
    try {
      const abi = (target && byAddress.get(target.toLowerCase())) || all;
      const result = decodeErrorResult({ abi, data });
      if (
        result.abiItem.type !== "error" ||
        result.errorName === "Error" ||
        result.errorName === "Panic"
      )
        return;
      return {
        errorName: result.errorName,
        args: named(result.abiItem.inputs, result.args ?? []),
      };
    } catch {
      return;
    }
  };
}
