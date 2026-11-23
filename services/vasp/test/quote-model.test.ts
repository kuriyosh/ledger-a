import { expect, test } from "vitest";
import { priceTrade, quoteInput, rfqRate } from "../src/quote-model.ts";

const fixed = rfqRate.parse("155.20");

test("rounds transfers toward the taker payment in both currency directions", () => {
  expect(priceTrade(fixed, "tUSD", { makerAmount: "1000000" })).toEqual({
    makerAmount: "1000000",
    takerAmount: "155200000",
  });
  expect(priceTrade(fixed, "tUSD", { makerAmount: "1" })).toEqual({
    makerAmount: "1",
    takerAmount: "156",
  });
  expect(priceTrade(fixed, "tUSD", { takerAmount: "156" })).toEqual({
    makerAmount: "1",
    takerAmount: "156",
  });
  expect(priceTrade(fixed, "tJPY", { takerAmount: "1" })).toEqual({
    makerAmount: "155",
    takerAmount: "1",
  });
  expect(priceTrade(fixed, "tJPY", { makerAmount: "156" })).toEqual({
    makerAmount: "156",
    takerAmount: "2",
  });
  expect(() => priceTrade(fixed, "tUSD", { takerAmount: "155" })).toThrow(
    "outside the supported range",
  );
});

test("rejects invalid amounts, token pairs and nonpositive rates", () => {
  expect(
    quoteInput.safeParse({
      sellToken: "tUSD",
      buyToken: "tJPY",
      sellAmount: "10",
      buyAmount: "20",
    }).success,
  ).toBe(false);
  expect(
    quoteInput.safeParse({
      sellToken: "tUSD",
      buyToken: "tUSD",
      sellAmount: "10",
    }).success,
  ).toBe(false);
  expect(
    quoteInput.safeParse({
      sellToken: "tUSD",
      buyToken: "tJPY",
      sellAmount: "not a number",
    }).success,
  ).toBe(false);
  expect(rfqRate.safeParse("0.0").success).toBe(false);
});
