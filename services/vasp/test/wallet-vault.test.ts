import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { createWalletVault } from "../src/wallet-vault.ts";

test("generates an encrypted wallet and recovers only for the right customer and encryption key", () => {
  const vault = createWalletVault(Buffer.alloc(32, 7));
  const anotherVault = createWalletVault(Buffer.alloc(32, 8));
  const first = vault.create("A-000001");
  const second = vault.create("A-000002");
  const key = vault.recover("A-000001", first.address, first.encrypted);
  expect(privateKeyToAccount(key).address).toBe(first.address);
  expect(first.encrypted.length).toBe(60);
  expect(first.encrypted.includes(Buffer.from(key.slice(2), "hex"))).toBe(
    false,
  );
  expect(first.address).not.toBe(second.address);
  expect(first.encrypted.subarray(0, 12)).not.toEqual(
    second.encrypted.subarray(0, 12),
  );
  expect(() =>
    vault.recover("A-000002", first.address, first.encrypted),
  ).toThrow();
  expect(() =>
    vault.recover("A-000001", second.address, first.encrypted),
  ).toThrow();
  expect(() =>
    anotherVault.recover("A-000001", first.address, first.encrypted),
  ).toThrow();
  const tampered = Buffer.from(first.encrypted);
  tampered[24] ^= 1;
  expect(() => vault.recover("A-000001", first.address, tampered)).toThrow();
});
