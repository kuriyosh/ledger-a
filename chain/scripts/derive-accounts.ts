import { randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { validateMnemonic } from "@scure/bip39";
import { english, mnemonicToAccount } from "viem/accounts";

const accountNames = [
  "ADMIN",
  "BATCHER",
  "SEQUENCER",
  "PROPOSER",
  "CHALLENGER",
  "GATEWAY",
  "RELAYER_A",
  "RELAYER_B",
  "VASP_A_ADMIN",
  "VASP_B_ADMIN",
  "VASP_A_SIGNER",
  "VASP_B_SIGNER",
  "VASP_B_TREASURY",
  "ISSUER",
  "CONSORTIUM_1",
  "CONSORTIUM_2",
  "CONSORTIUM_3",
  "ATTACKER",
] as const;

const secretNames = [
  "GATEWAY_ADMIN_TOKEN",
  "VASP_A_ADMIN_TOKEN",
  "VASP_B_ADMIN_TOKEN",
  "CONSORTIUM_ADMIN_TOKEN",
  "AUDITOR_ADMIN_TOKEN",
  "VASP_A_GATEWAY_API_KEY",
  "VASP_B_GATEWAY_API_KEY",
  "VASP_A_AUDITOR_KEY",
  "VASP_B_AUDITOR_KEY",
  "VASP_A_KEY_ENCRYPTION_KEY",
  "VASP_B_KEY_ENCRYPTION_KEY",
] as const;

function isFsError(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

async function upgradeAuditToken(
  output: string,
  temporary: string,
  prior: string,
) {
  const proposed = join(temporary, "proposed");
  const ready = join(temporary, "ready");
  const pending = `${output}.auditor-upgrade`;
  const key = randomBytes(32).toString("hex");
  await writeFile(
    proposed,
    `${prior.trimEnd()}\nAUDITOR_ADMIN_TOKEN=${key}\n`,
    { mode: 0o600 },
  );
  try {
    await link(proposed, pending);
  } catch (error) {
    if (!isFsError(error, "EEXIST")) throw error;
  }
  try {
    await link(pending, ready);
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error;
  }
  // Link before rereading so a late contender cannot replace a published token.
  if (
    parseEnv(await readFile(output, "utf8")).AUDITOR_ADMIN_TOKEN === undefined
  ) {
    await rename(ready, output);
  }
  await rm(pending, { force: true });
}

export async function generateAccounts(mnemonic: string, output: string) {
  mnemonic = mnemonic.trim().split(/\s+/).join(" ");
  if (
    mnemonic === "test test test test test test test test test test test junk"
  ) {
    throw new Error(
      "LEDGERA_MNEMONIC is the public Anvil default. Generate a new mnemonic",
    );
  }
  if (
    ![12, 24].includes(mnemonic.split(" ").length) ||
    !validateMnemonic(mnemonic, english)
  ) {
    throw new Error(
      "LEDGERA_MNEMONIC must be a valid 12- or 24-word English BIP-39 mnemonic",
    );
  }

  const accounts = accountNames.map((name, addressIndex) => {
    const account = mnemonicToAccount(mnemonic, { addressIndex });
    const { privateKey } = account.getHdKey();
    if (!privateKey) throw new Error("Account derivation failed");
    return {
      name,
      address: account.address,
      privateKey: `0x${Buffer.from(privateKey).toString("hex")}`,
    };
  });
  const accountEnv = accounts.flatMap(({ name, privateKey, address }) => [
    [`${name}_PRIVATE_KEY`, privateKey],
    [`${name}_ADDRESS`, address],
  ]);
  const secrets = secretNames.map((name) => [
    name,
    randomBytes(32).toString("hex"),
  ]);
  const content = [...accountEnv, ...secrets]
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");

  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const tempDir = await mkdtemp(join(parent, ".env.keys-"));
  try {
    const tempFile = join(tempDir, basename(output));
    await writeFile(tempFile, content, { mode: 0o600 });
    try {
      // Publish atomically so concurrent runs keep the same service credentials.
      await link(tempFile, output);
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
      if ((await stat(output)).mode & 0o077) {
        throw new Error(`${output} must be accessible only to its owner`);
      }
      const prior = await readFile(output, "utf8");
      const existing = parseEnv(prior);
      const needsAuditToken = existing.AUDITOR_ADMIN_TOKEN === undefined;
      if (
        accountEnv.some(([name, value]) => existing[name] !== value) ||
        secretNames.some(
          (name) =>
            (name !== "AUDITOR_ADMIN_TOKEN" || !needsAuditToken) &&
            !/^[0-9a-f]{64}$/.test(existing[name] ?? ""),
        )
      ) {
        throw new Error(
          `${output} does not match the requested accounts or is incomplete`,
        );
      }
      if (needsAuditToken) {
        await upgradeAuditToken(output, tempDir, prior);
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  return accounts.map(({ name, address }) => ({ name, address }));
}

if (import.meta.main === undefined) {
  throw new Error("Account generation requires Node.js 24.2 or later");
}
if (import.meta.main) {
  try {
    console.table(
      await generateAccounts(
        process.env.LEDGERA_MNEMONIC ?? "",
        ".env.generated",
      ),
    );
    console.log("Sepolia ETH: admin 3, batcher 0.5, attacker 0.05");
    console.log("L2 ETH: 1 per operating account that sends L2 transactions");
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Account generation failed",
    );
    process.exitCode = 1;
  }
}
