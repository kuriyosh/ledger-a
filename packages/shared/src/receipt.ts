import {
  type Address,
  encodeAbiParameters,
  type Hex,
  hashStruct,
  hashTypedData,
  keccak256,
  type LocalAccount,
} from "viem";

export const receiptTypes = {
  Receipt: [
    { name: "seq", type: "uint64" },
    { name: "txHash", type: "bytes32" },
    { name: "sender", type: "address" },
    { name: "receivedAtMs", type: "uint64" },
    { name: "prevHash", type: "bytes32" },
  ],
} as const;

export type Receipt = {
  seq: bigint;
  txHash: Hex;
  sender: Address;
  receivedAtMs: bigint;
  prevHash: Hex;
};

type ReceiptDomain = { chainId: number; verifyingContract: Address };

function receiptData(domain: ReceiptDomain, message: Receipt) {
  return {
    domain: { ...domain, name: "ledgerA Gateway", version: "1" },
    types: receiptTypes,
    primaryType: "Receipt",
    message,
  } as const;
}

export function receiptGenesisHash(domain: ReceiptDomain) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }],
      ["ledgerA ReceiptLog", BigInt(domain.chainId), domain.verifyingContract],
    ),
  );
}

export function hashReceiptEntry(data: Receipt) {
  return hashStruct({ data, types: receiptTypes, primaryType: "Receipt" });
}

export function hashReceiptDigest(domain: ReceiptDomain, message: Receipt) {
  return hashTypedData(receiptData(domain, message));
}

export function signReceipt(
  signer: LocalAccount,
  domain: ReceiptDomain,
  message: Receipt,
) {
  return signer.signTypedData(receiptData(domain, message));
}
