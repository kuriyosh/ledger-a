import { z } from "zod";

export type AlertRule = "LARGE_AMOUNT" | "WATCHLIST";
export type TokenSymbol = "tUSD" | "tJPY";
export type AmlSettings = {
  thresholds: Readonly<Record<TokenSymbol, bigint>>;
  watchlist: readonly string[];
};

const normalizedName = (value: string) =>
  value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

export const amlWatchlist = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map(normalizedName)
      .filter((entry) => entry.length > 0),
  );

export const amlThreshold = z
  .string()
  .regex(/^\d{1,24}(?:\.\d{1,6})?$/)
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole + fraction.padEnd(6, "0"));
  });

export function amlFindings(
  transfer: {
    senderKind: number;
    token: TokenSymbol;
    amount: bigint;
    familyName: string;
    givenName: string;
  },
  settings: AmlSettings,
): AlertRule[] {
  if (transfer.senderKind !== 1) return [];
  const rules: AlertRule[] = [];
  if (transfer.amount >= settings.thresholds[transfer.token])
    rules.push("LARGE_AMOUNT");
  if (
    settings.watchlist.includes(
      normalizedName(transfer.familyName + transfer.givenName),
    )
  )
    rules.push("WATCHLIST");
  return rules;
}
