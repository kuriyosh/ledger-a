import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const nonceSize = 12;
const keySize = 32;
const tagSize = 16;

function associatedData(id: string, address: Address) {
  return Buffer.from(`${id}\n${address.toLowerCase()}`, "utf8");
}

export function createWalletVault(key: Buffer) {
  if (key.length !== keySize)
    throw new RangeError("Expected a 256-bit wallet encryption key");
  return {
    create(id: string) {
      const privateKey = generatePrivateKey();
      const { address } = privateKeyToAccount(privateKey);
      const nonce = randomBytes(nonceSize);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(associatedData(id, address));
      const encrypted = Buffer.concat([
        nonce,
        cipher.update(Buffer.from(privateKey.slice(2), "hex")),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return { address, encrypted };
    },
    recover(id: string, address: Address, encrypted: Buffer): Hex {
      if (encrypted.length !== nonceSize + keySize + tagSize) {
        throw new TypeError("Invalid encrypted wallet record");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        encrypted.subarray(0, nonceSize),
      );
      decipher.setAAD(associatedData(id, address));
      decipher.setAuthTag(encrypted.subarray(-tagSize));
      const value = Buffer.concat([
        decipher.update(encrypted.subarray(nonceSize, -tagSize)),
        decipher.final(),
      ]);
      return `0x${value.toString("hex")}`;
    },
  };
}
