import { writeFileSync } from "node:fs";
import { encodeFunctionData, parseAbi, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  type ForwardRequest,
  hashForwardRequest,
  signForwardRequest,
} from "../src/forward-request.ts";

const signer = privateKeyToAccount(toHex(3, { size: 32 }));
const domain = {
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000001400",
} as const;
const message: ForwardRequest = {
  from: signer.address,
  to: "0x0000000000000000000000000000000000001401",
  value: 0n,
  gas: 100_000n,
  nonce: 0n,
  deadline: 1_800_000_000,
  data: encodeFunctionData({
    abi: parseAbi(["function record()"]),
    functionName: "record",
  }),
};
const vector = {
  domain,
  message: {
    ...message,
    value: message.value.toString(),
    gas: message.gas.toString(),
    nonce: message.nonce.toString(),
  },
  hash: hashForwardRequest(domain, message),
  signature: await signForwardRequest(signer, domain, message),
};
writeFileSync(
  new URL("vectors/forward-request.json", import.meta.url),
  `${JSON.stringify(vector, null, 2)}\n`,
);
