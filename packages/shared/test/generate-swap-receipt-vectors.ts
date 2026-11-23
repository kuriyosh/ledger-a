import { writeFileSync } from "node:fs";
import { toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashQuote, type Quote, signQuote } from "../src/quote.ts";
import {
  hashReceiptDigest,
  hashReceiptEntry,
  type Receipt,
  receiptGenesisHash,
  signReceipt,
} from "../src/receipt.ts";

const maker = privateKeyToAccount(toHex(4, { size: 32 }));
const quoteDomain = {
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000001500",
} as const;
const quote: Quote = {
  maker: maker.address,
  taker: "0x0000000000000000000000000000000000001501",
  makerToken: "0x0000000000000000000000000000000000001502",
  takerToken: "0x0000000000000000000000000000000000001503",
  makerAmount: 1_234_567n,
  takerAmount: 52_631_000n,
  expiry: 1_800_000_000n,
  nonce: 17n,
};

const signer = privateKeyToAccount(toHex(5, { size: 32 }));
const receiptDomain = {
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000001600",
} as const;
const receipt: Receipt = {
  seq: 1n,
  txHash: toHex(100, { size: 32 }),
  sender: "0x0000000000000000000000000000000000001601",
  receivedAtMs: 1_777_777_777_777n,
  prevHash: receiptGenesisHash(receiptDomain),
};

function write(name: string, vector: unknown) {
  const contents = JSON.stringify(
    vector,
    (_, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    2,
  );
  writeFileSync(
    new URL(`vectors/${name}.json`, import.meta.url),
    `${contents}\n`,
  );
}

write("quote", {
  domain: quoteDomain,
  message: quote,
  hash: hashQuote(quoteDomain, quote),
  signature: await signQuote(maker, quoteDomain, quote),
});
write("receipt", {
  domain: receiptDomain,
  message: receipt,
  signer: signer.address,
  entryHash: hashReceiptEntry(receipt),
  digest: hashReceiptDigest(receiptDomain, receipt),
  signature: await signReceipt(signer, receiptDomain, receipt),
});
