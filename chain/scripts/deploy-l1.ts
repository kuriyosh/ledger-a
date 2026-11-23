import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { isAddressEqual, parseAbi, zeroAddress } from "viem";
import { sepolia } from "viem/chains";
import {
  address,
  adminWallet,
  required,
  requirePlainAccount,
  sepoliaClient,
} from "./l1.ts";

const workdir = "chain/.deployer";
const intentFile = `${workdir}/intent.toml`;
const stateFile = `${workdir}/state.json`;

const toolEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  SSL_CERT_FILE: process.env.SSL_CERT_FILE,
  SSL_CERT_DIR: process.env.SSL_CERT_DIR,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  NO_PROXY: process.env.NO_PROXY,
};

function run(binary: string, args: string[], env: NodeJS.ProcessEnv = toolEnv) {
  const result = spawnSync(binary, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed`);
}

const systemConfigAbi = parseAbi([
  "function owner() view returns (address)",
  "function basefeeScalar() view returns (uint32)",
  "function blobbasefeeScalar() view returns (uint32)",
  "function setGasConfigEcotone(uint32 basefeeScalar, uint32 blobbasefeeScalar)",
]);

async function main(deployer: string) {
  const chainId = Number(required("L2_CHAIN_ID"));
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    chainId === sepolia.id
  ) {
    throw new Error(
      "L2_CHAIN_ID must be a positive integer distinct from the L1 chain ID",
    );
  }
  const wallet = adminWallet();
  const admin = wallet.account;

  const roles = {
    l1ProxyAdminOwner: admin.address,
    l2ProxyAdminOwner: admin.address,
    systemConfigOwner: admin.address,
    unsafeBlockSigner: address(required("SEQUENCER_ADDRESS")),
    batcher: address(required("BATCHER_ADDRESS")),
    proposer: address(required("PROPOSER_ADDRESS")),
    challenger: address(required("CHALLENGER_ADDRESS")),
  };
  const overrides = {
    l2BlockTime: 2,
    gasPriceOracleBaseFeeScalar: 0,
    gasPriceOracleBlobBaseFeeScalar: 0,
  };
  const publicClient = await sepoliaClient();
  await Promise.all([
    requirePlainAccount(publicClient, admin.address, "Admin"),
    requirePlainAccount(publicClient, roles.batcher, "Batcher"),
  ]);

  const hasIntent = existsSync(intentFile);
  const hasState = existsSync(stateFile);
  if (hasIntent !== hasState) {
    throw new Error(
      "op-deployer intent.toml and state.json must both be present in chain/.deployer",
    );
  }
  if (!hasIntent) {
    run(deployer, [
      "init",
      "--l1-chain-id",
      String(sepolia.id),
      "--l2-chain-ids",
      String(chainId),
      "--workdir",
      workdir,
      "--intent-type",
      "standard-overrides",
    ]);
  }
  const intent = parse(readFileSync(intentFile, "utf8"));
  const chains = intent.chains;
  const chain = Array.isArray(chains) && chains.length === 1 ? chains[0] : null;
  if (
    !chain ||
    typeof chain !== "object" ||
    !("id" in chain) ||
    BigInt(String(chain.id)) !== BigInt(chainId) ||
    intent.l1ChainID !== sepolia.id
  ) {
    throw new Error(
      "The existing op-deployer intent uses a different chain ID",
    );
  }
  const expected = {
    baseFeeVaultRecipient: admin.address,
    l1FeeVaultRecipient: admin.address,
    sequencerFeeVaultRecipient: admin.address,
    operatorFeeVaultRecipient: admin.address,
    roles,
    deployOverrides: overrides,
  };
  if (
    intent.fundDevAccounts === false &&
    chain.baseFeeVaultRecipient === zeroAddress
  ) {
    Object.assign(chain, expected);
    intent.fundDevAccounts = true;
    const temp = `${intentFile}.tmp`;
    writeFileSync(temp, stringify(intent));
    renameSync(temp, intentFile);
  } else if (
    intent.fundDevAccounts !== true ||
    Object.entries(expected).some(([key, value]) => {
      const current = chain[key];
      return typeof value === "object"
        ? !current ||
            typeof current !== "object" ||
            Object.entries(value).some(
              ([field, entry]) =>
                !(field in current) || Reflect.get(current, field) !== entry,
            )
        : current !== value;
    })
  ) {
    throw new Error(
      "The existing intent does not match the selected deployment accounts and chain settings",
    );
  }
  const existingState = JSON.parse(readFileSync(stateFile, "utf8"));
  if (!existingState.appliedIntent) {
    run(
      deployer,
      [
        "apply",
        "--workdir",
        workdir,
        "--deployment-target",
        "live",
        "--no-verify",
      ],
      {
        ...toolEnv,
        L1_RPC_URL: required("L1_RPC_URL"),
        DEPLOYER_PRIVATE_KEY: required("ADMIN_PRIVATE_KEY"),
      },
    );
  }

  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const deployment = state.opChainDeployments?.[0];
  if (
    !state.appliedIntent ||
    !deployment ||
    BigInt(String(deployment.id)) !== BigInt(chainId)
  ) {
    throw new Error(
      "op-deployer state does not contain the selected chain deployment",
    );
  }
  const systemConfig = address(deployment.SystemConfigProxy);
  address(deployment.OptimismPortalProxy);
  const config = { address: systemConfig, abi: systemConfigAbi } as const;
  const owner = await publicClient.readContract({
    ...config,
    functionName: "owner",
  });
  if (!isAddressEqual(owner, admin.address))
    throw new Error("Admin must own the deployed SystemConfig");
  const scalarsAreZero = async (blockNumber?: bigint) => {
    const scalars = await Promise.all([
      publicClient.readContract({
        ...config,
        blockNumber,
        functionName: "basefeeScalar",
      }),
      publicClient.readContract({
        ...config,
        blockNumber,
        functionName: "blobbasefeeScalar",
      }),
    ]);
    return scalars.every((scalar) => scalar === 0);
  };
  if (!(await scalarsAreZero())) {
    const { request } = await publicClient.simulateContract({
      ...config,
      account: admin,
      functionName: "setGasConfigEcotone",
      args: [0, 0],
    });
    const hash = await wallet.writeContract(request);
    console.log(`SystemConfig fee update: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
    });
    if (receipt.status !== "success")
      throw new Error("SystemConfig fee update reverted");
    if (!(await scalarsAreZero(receipt.blockNumber))) {
      throw new Error("SystemConfig fee scalars must both be zero");
    }
  }

  run("bash", ["chain/scripts/gen-config.sh", deployer, String(chainId)]);
}

const deployer = process.argv[2];
try {
  if (!deployer) throw new Error("Run make chain-deploy");
  await main(deployer);
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.split("\n", 1)[0]
      : "Deployment failed",
  );
  process.exitCode = 1;
}
