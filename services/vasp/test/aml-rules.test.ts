import { expect, test } from "vitest";
import { amlFindings, amlThreshold, amlWatchlist } from "../src/aml-rules.ts";

test("matches the asset threshold and normalized beneficiary, only for customer deposits", () => {
  const transfer = {
    senderKind: 1,
    token: "tUSD",
    amount: 10_010_000n,
    familyName: "Ｌｉｍ",
    givenName: "Wei",
  } as const;
  const settings = {
    thresholds: {
      tUSD: amlThreshold.parse("10.01"),
      tJPY: amlThreshold.parse("500000"),
    },
    watchlist: amlWatchlist.parse(" , Lim Wei,"),
  };
  expect(amlFindings(transfer, settings)).toEqual([
    "LARGE_AMOUNT",
    "WATCHLIST",
  ]);
  expect(
    amlFindings({ ...transfer, amount: transfer.amount - 1n }, settings),
  ).toEqual(["WATCHLIST"]);
  expect(amlFindings({ ...transfer, token: "tJPY" }, settings)).toEqual([
    "WATCHLIST",
  ]);
  expect(amlFindings({ ...transfer, senderKind: 0 }, settings)).toEqual([]);
  expect(amlFindings({ ...transfer, senderKind: 2 }, settings)).toEqual([]);
});
