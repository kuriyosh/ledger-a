import { ServiceError } from "@ledgera/shared/errors";
import type { Quote } from "@ledgera/shared/quote";
import { getAddress, type Hex, isAddress } from "viem";
import { z } from "zod";

const maxAmount = (1n << 256n) - 1n;
const address = z
  .string()
  .refine((value) => isAddress(value), { abort: true })
  .transform((value) => getAddress(value));
const amount = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .pipe(z.string().refine((value) => BigInt(value) <= maxAmount));
const nonce = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
const halfOrder =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const signature = z
  .string()
  .regex(/^0x[0-9a-fA-F]{128}(1[bBcC])$/)
  .pipe(
    z.string().refine((value) => {
      const s = BigInt(`0x${value.slice(66, 130)}`);
      return s > 0n && s <= halfOrder;
    }),
  )
  .transform((value) => value.toLowerCase() as Hex);

const tokenName = z.enum(["tJPY", "tUSD"]);

export const rfqInput = z
  .object({
    taker: address,
    takerToken: address,
    makerToken: address,
    takerAmount: amount.optional(),
    makerAmount: amount.optional(),
  })
  .refine(
    (value) =>
      (value.takerAmount === undefined) !== (value.makerAmount === undefined),
  );

export const quoteInput = z
  .object({
    sellToken: tokenName,
    buyToken: tokenName,
    sellAmount: amount.optional(),
    buyAmount: amount.optional(),
  })
  .refine(
    (value) =>
      value.sellToken !== value.buyToken &&
      (value.sellAmount === undefined) !== (value.buyAmount === undefined),
  );

const wireQuote = z.object({
  maker: address,
  taker: address,
  makerToken: address,
  takerToken: address,
  makerAmount: amount,
  takerAmount: amount,
  expiry: z.int().positive(),
  nonce,
});

export const quoteReply = z.object({ quote: wireQuote, signature });
export type RfqInput = z.infer<typeof rfqInput>;
export type QuoteInput = z.infer<typeof quoteInput>;
export type QuoteWire = z.infer<typeof wireQuote>;

export const rfqRate = z
  .string()
  .regex(/^\d{1,10}(?:\.\d{1,12})?$/)
  .transform((value) => {
    const [whole, decimal = ""] = value.split(".");
    return { yen: BigInt(whole + decimal), usd: 10n ** BigInt(decimal.length) };
  })
  .refine(({ yen }) => yen > 0n);

export function priceTrade(
  rate: z.infer<typeof rfqRate>,
  buy: z.infer<typeof tokenName>,
  requested: Pick<RfqInput, "takerAmount" | "makerAmount">,
) {
  const [numerator, denominator] =
    buy === "tUSD" ? [rate.yen, rate.usd] : [rate.usd, rate.yen];
  const taker =
    requested.takerAmount === undefined
      ? (BigInt(requested.makerAmount ?? 0) * numerator + denominator - 1n) /
        denominator
      : BigInt(requested.takerAmount);
  const maker =
    requested.makerAmount === undefined
      ? (taker * denominator) / numerator
      : BigInt(requested.makerAmount);
  if (maker === 0n || taker === 0n || maker > maxAmount || taker > maxAmount)
    throw new ServiceError(
      "RFQ_AMOUNT_OUT_OF_RANGE",
      "Quote amounts are outside the supported range",
      422,
    );
  return { makerAmount: maker.toString(), takerAmount: taker.toString() };
}

export function quoteTyped(quote: QuoteWire): Quote {
  return {
    ...quote,
    makerAmount: BigInt(quote.makerAmount),
    takerAmount: BigInt(quote.takerAmount),
    expiry: BigInt(quote.expiry),
    nonce: BigInt(quote.nonce),
  };
}

export function effectiveRate(quote: QuoteWire, yenToken: string) {
  const sellYen = quote.takerToken.toLowerCase() === yenToken.toLowerCase();
  const yen = BigInt(sellYen ? quote.takerAmount : quote.makerAmount);
  const usd = BigInt(sellYen ? quote.makerAmount : quote.takerAmount);
  const hundredths = (yen * 100n + usd / 2n) / usd;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}
