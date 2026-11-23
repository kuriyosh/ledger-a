import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { expect, test } from "vitest";
import { generateAccounts } from "./derive-accounts.ts";

const testMnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("derives the documented paths and creates one private file across concurrent runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledgera-keys-"));
  const file = join(dir, ".env.generated");
  try {
    const [first, second] = await Promise.all([
      generateAccounts(testMnemonic, file),
      generateAccounts(testMnemonic, file),
    ]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(18);
    expect(first[0]).toEqual({
      name: "ADMIN",
      address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    });
    expect(first[17]).toEqual({
      name: "ATTACKER",
      address: "0x516A2191b53f7654654F209CcA9668b16f149988",
    });
    const contents = await readFile(file, "utf8");
    const env = parseEnv(contents);
    expect(Object.keys(env)).toHaveLength(47);
    expect(env.AUDITOR_ADMIN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env.ADMIN_PRIVATE_KEY).toMatch(/^0x[0-9a-f]{64}$/);
    expect(env.VASP_A_KEY_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env.VASP_A_KEY_ENCRYPTION_KEY).not.toEqual(
      env.VASP_B_KEY_ENCRYPTION_KEY,
    );
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await generateAccounts(testMnemonic, file);
    expect(await readFile(file, "utf8")).toBe(contents);
    const old = contents
      .split("\n")
      .filter((line) => !line.startsWith("AUDITOR_ADMIN_TOKEN="))
      .join("\n");
    await writeFile(file, old);
    const observed = await Promise.all(
      Array.from({ length: 12 }, async () => {
        await generateAccounts(testMnemonic, file);
        return parseEnv(await readFile(file, "utf8")).AUDITOR_ADMIN_TOKEN;
      }),
    );
    expect(new Set(observed).size).toBe(1);
    const upgraded = parseEnv(await readFile(file, "utf8"));
    expect(upgraded.AUDITOR_ADMIN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    delete upgraded.AUDITOR_ADMIN_TOKEN;
    expect(upgraded).toEqual(parseEnv(old));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an invalid mnemonic before touching the output", async () => {
  await expect(
    generateAccounts("invalid", "/invalid/.env.generated"),
  ).rejects.toThrow("valid 12- or 24-word");
});

test("rejects the public Anvil default mnemonic", async () => {
  await expect(
    generateAccounts(
      "test test test test test test test test test test test junk",
      "/invalid/.env.generated",
    ),
  ).rejects.toThrow("public Anvil default");
});
