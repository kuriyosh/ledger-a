import { randomBytes } from "node:crypto";
import type { Deployment } from "@ledgera/config";
import { ServiceError } from "@ledgera/shared/errors";
import { signHttpRequest } from "@ledgera/shared/http-signature";
import { hashQuote, signQuote } from "@ledgera/shared/quote";
import {
  type Address,
  bytesToHex,
  type Hex,
  type LocalAccount,
  recoverAddress,
} from "viem";
import type { registryChain } from "./chain.ts";
import type { SwapStore } from "./db/swaps.ts";
import {
  effectiveRate,
  priceTrade,
  type QuoteInput,
  type QuoteWire,
  quoteReply,
  quoteTyped,
  type RfqInput,
} from "./quote-model.ts";
import type { transferChain } from "./transfer-chain.ts";

const rfqPath = "/vasp/v1/rfq/quotes";
const now = () => Math.floor(Date.now() / 1_000);
const same = (left: Address, right: Address) =>
  left.toLowerCase() === right.toLowerCase();

function invalid() {
  return new ServiceError(
    "RFQ_INVALID_QUOTE",
    "Maker returned an invalid quote",
    503,
  );
}

export function quoteService(
  store: Pick<SwapStore, "issue" | "quote">,
  registry: Pick<ReturnType<typeof registryChain>, "vasp" | "account">,
  chain: Pick<ReturnType<typeof transferChain>, "recipient">,
  deployment: Deployment,
  config: {
    ownId: number;
    vaspSigner: LocalAccount;
    makerId: number;
    maker?: {
      signer: LocalAccount;
      ttl: number;
      rate: { yen: bigint; usd: bigint };
    };
  },
  requestHttp = fetch,
) {
  const tokens = {
    tJPY: deployment.contracts.tJPY,
    tUSD: deployment.contracts.tUSD,
  };
  const domain = {
    chainId: deployment.chainId,
    verifyingContract: deployment.contracts.atomicSwap,
  };

  async function treasury(address: Address, vaspId: number) {
    const account = await registry.account(address);
    return (
      account.kind === 2 && account.vaspId === vaspId && account.status === 1
    );
  }

  return {
    async verifyMaker() {
      if (
        config.maker &&
        !(await treasury(config.maker.signer.address, config.ownId))
      )
        throw new Error("Treasury key does not match the active VASP treasury");
    },
    async issue(vaspId: number, requested: RfqInput, digest: Hex) {
      const maker = config.maker;
      if (!maker)
        throw new ServiceError(
          "MARKET_MAKER_DISABLED",
          "Market maker is not enabled",
          404,
        );
      const [holder, permitted] = await Promise.all([
        chain.recipient(requested.taker),
        treasury(maker.signer.address, config.ownId),
      ]);
      if (!holder.eligible || holder.vaspId !== vaspId || !permitted)
        throw new ServiceError(
          "RFQ_TAKER_NOT_ELIGIBLE",
          "RFQ parties are not eligible",
          403,
        );

      const buy =
        same(requested.makerToken, tokens.tUSD) &&
        same(requested.takerToken, tokens.tJPY)
          ? "tUSD"
          : same(requested.makerToken, tokens.tJPY) &&
              same(requested.takerToken, tokens.tUSD)
            ? "tJPY"
            : undefined;
      if (!buy)
        throw new ServiceError(
          "RFQ_PAIR_NOT_SUPPORTED",
          "Unsupported settlement tokens",
          422,
        );
      const quote: QuoteWire = {
        maker: maker.signer.address,
        taker: requested.taker,
        makerToken: requested.makerToken,
        takerToken: requested.takerToken,
        ...priceTrade(maker.rate, buy, requested),
        nonce: bytesToHex(randomBytes(32)),
        expiry: now() + maker.ttl,
      };
      const signature = await signQuote(
        maker.signer,
        domain,
        quoteTyped(quote),
      );
      return store.issue(
        { quote, signature },
        hashQuote(domain, quoteTyped(quote)),
        digest,
        vaspId,
      );
    },
    async acquire(customerId: string, taker: Address, input: QuoteInput) {
      const member = await registry.vasp(config.makerId);
      if (member.status !== 1)
        throw new ServiceError(
          "MARKET_MAKER_UNAVAILABLE",
          "Market maker is not active",
          503,
        );
      const requested = {
        taker,
        takerToken: tokens[input.sellToken],
        makerToken: tokens[input.buyToken],
        takerAmount: input.sellAmount,
        makerAmount: input.buyAmount,
      };
      const started = now();
      let untrusted: unknown;
      try {
        const request = new Request(new URL(rfqPath, member.endpoint), {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requested),
          signal: AbortSignal.timeout(5_000),
        });
        const headers = await signHttpRequest(
          config.vaspSigner,
          request,
          config.ownId,
          started,
        );
        for (const [key, value] of Object.entries(headers))
          request.headers.set(key, value);
        const response = await requestHttp(request);
        if (response.ok) untrusted = await response.json();
      } catch {
        throw new ServiceError(
          "MARKET_MAKER_UNAVAILABLE",
          "Could not reach market maker",
          503,
        );
      }
      const reply = quoteReply.safeParse(untrusted);
      if (!reply.success) throw invalid();
      const { quote, signature } = reply.data;
      if (
        !same(quote.taker, taker) ||
        !same(quote.takerToken, requested.takerToken) ||
        !same(quote.makerToken, requested.makerToken) ||
        quote.expiry <= now() ||
        quote.expiry > started + 86_700 ||
        (input.sellAmount && quote.takerAmount !== input.sellAmount) ||
        (input.buyAmount && quote.makerAmount !== input.buyAmount)
      )
        throw invalid();
      try {
        const signedBy = await recoverAddress({
          hash: hashQuote(domain, quoteTyped(quote)),
          signature,
        });
        if (
          !same(signedBy, quote.maker) ||
          !(await treasury(signedBy, config.makerId))
        )
          throw invalid();
      } catch {
        throw invalid();
      }
      const quoteId = await store.quote(
        customerId,
        { quote, signature },
        hashQuote(domain, quoteTyped(quote)),
      );
      return {
        quoteId,
        sellAmount: quote.takerAmount,
        buyAmount: quote.makerAmount,
        rate: effectiveRate(quote, tokens.tJPY),
        expiresAt: new Date(quote.expiry * 1000),
      };
    },
  };
}
