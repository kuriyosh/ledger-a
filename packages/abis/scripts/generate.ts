import { readFileSync, writeFileSync } from "node:fs";

const artifacts = {
  kycRegistryAbi: "KycRegistry",
  ledgerTokenAbi: "LedgerToken",
  travelRuleComplianceAbi: "TravelRuleCompliance",
  ledgerForwarderAbi: "LedgerForwarder",
  atomicSwapAbi: "AtomicSwap",
  receiptLogAbi: "ReceiptLog",
  depositProbeAbi: "DepositProbe",
  consortiumSafeAbi: "GnosisSafeL2",
  safeProxyAbi: "GnosisSafeProxy",
} as const;

const root = new URL("../../../contracts/out/", import.meta.url);
const definitions = Object.entries(artifacts).map(([symbol, contract]) => {
  const artifact = new URL(`${contract}.sol/${contract}.json`, root);
  const { abi } = JSON.parse(readFileSync(artifact, "utf8"));
  if (!Array.isArray(abi))
    throw new Error(`Missing ABI in ${artifact.pathname}`);
  return `export const ${symbol} = ${JSON.stringify(abi, null, 2)} as const;\n`;
});

writeFileSync(
  new URL("../src/generated.ts", import.meta.url),
  definitions.join("\n"),
);
