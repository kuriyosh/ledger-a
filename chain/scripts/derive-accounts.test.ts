import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { expect, test } from "vitest";
import { generateAccounts } from "./derive-accounts.ts";

const anvilMnemonic =
  "test test test test test test test test test test test junk";

test("derives the documented paths and creates one private file across concurrent runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledgera-keys-"));
  const file = join(dir, ".env.generated");
  try {
    const [first, second] = await Promise.all([
      generateAccounts(anvilMnemonic, file),
      generateAccounts(anvilMnemonic, file),
    ]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(18);
    expect(first[0]).toEqual({
      name: "ADMIN",
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    });
    expect(first[17]).toEqual({
      name: "ATTACKER",
      address: "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E",
    });
    const contents = await readFile(file, "utf8");
    const env = parseEnv(contents);
    expect(Object.keys(env)).toHaveLength(46);
    expect(env.ADMIN_PRIVATE_KEY).toMatch(/^0x[0-9a-f]{64}$/);
    expect(env.VASP_A_KEY_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env.VASP_A_KEY_ENCRYPTION_KEY).not.toEqual(
      env.VASP_B_KEY_ENCRYPTION_KEY,
    );
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await generateAccounts(anvilMnemonic, file);
    expect(await readFile(file, "utf8")).toBe(contents);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an invalid mnemonic before touching the output", async () => {
  await expect(
    generateAccounts("invalid", "/invalid/.env.generated"),
  ).rejects.toThrow("valid 12- or 24-word");
});
