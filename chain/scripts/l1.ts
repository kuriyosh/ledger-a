import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  isAddress,
  isAddressEqual,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function address(value: unknown): Address {
  if (
    typeof value !== "string" ||
    !isAddress(value, { strict: false }) ||
    isAddressEqual(value, zeroAddress)
  ) {
    throw new Error("Configuration is missing a required address");
  }
  return value;
}

export async function sepoliaClient() {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(required("L1_RPC_URL")),
  });
  if ((await client.getChainId()) !== sepolia.id)
    throw new Error("L1_RPC_URL must point to Sepolia");
  return client;
}

export async function requirePlainAccount(
  client: Awaited<ReturnType<typeof sepoliaClient>>,
  account: Address,
  role: string,
) {
  const code = await client.getCode({ address: account });
  if (code && code !== "0x")
    throw new Error(`${role} must be an EOA without code on Sepolia`);
}

export function adminWallet() {
  const key = required("ADMIN_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error("Run make keys to generate ADMIN_PRIVATE_KEY");
  const account = privateKeyToAccount(key as Hex);
  if (!isAddressEqual(account.address, address(required("ADMIN_ADDRESS")))) {
    throw new Error("ADMIN_PRIVATE_KEY does not match ADMIN_ADDRESS");
  }
  return createWalletClient({
    account,
    chain: sepolia,
    transport: http(required("L1_RPC_URL")),
  });
}
