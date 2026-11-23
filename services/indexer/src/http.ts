import type { Deployment } from "@ledgera/config";
import { ServiceError } from "@ledgera/shared/errors";
import type { serviceApp } from "@ledgera/shared/server";
import { getAddress, type Hex, isAddress } from "viem";
import { z } from "zod";
import type { chainQuery } from "./query.ts";
import type { registryQuery } from "./registry-query.ts";

const address = z
  .string()
  .refine((value) => isAddress(value), { abort: true })
  .transform((value) => getAddress(value));
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
const height = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .transform(BigInt)
  .pipe(z.bigint().max(0x7fff_ffff_ffff_ffffn));
const index = z
  .string()
  .regex(/^(0|[1-9]\d{0,9})$/)
  .transform(Number)
  .pipe(z.int().max(0x7fff_ffff));
const position = z
  .string()
  .transform((value) => value.split(":"))
  .pipe(z.union([z.tuple([height]), z.tuple([height, index])]))
  .transform(([block, index]) => ({ block, index }));
const limit = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.int().min(1).max(100))
  .prefault("50");
const page = z.object({ limit, before: position.optional() });
const txKind = z.enum([
  "TOKEN_TRANSFER",
  "TOKEN_MINT",
  "TOKEN_BURN",
  "SWAP",
  "REGISTRY_UPDATE",
  "SAFE_APPROVE",
  "SAFE_EXECUTE",
  "RECEIPT_COMMIT",
  "L1_ATTRIBUTES",
  "DEPOSIT",
  "CONTRACT_DEPLOY",
  "OTHER",
]);
const statuses = ["NONE", "ACTIVE", "SUSPENDED", "BLOCKED", "REVOKED"] as const;
const accountStatus = z.union([
  z.enum(statuses).transform((status) => statuses.indexOf(status)),
  z
    .string()
    .regex(/^[0-4]$/)
    .transform(Number),
]);
const accountFilters = z.object({
  vaspId: z
    .string()
    .regex(/^\d{1,10}$/)
    .transform(Number)
    .pipe(z.int().max(0xffff_ffff))
    .optional(),
  status: accountStatus.optional(),
  registeredFromBlock: height.optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ServiceError("INVALID_REQUEST", "Invalid indexer query", 400);
  return result.data;
}

export function indexerRoutes(
  app: ReturnType<typeof serviceApp>,
  chain: ReturnType<typeof chainQuery>,
  registry: ReturnType<typeof registryQuery>,
  contracts: Deployment["contracts"],
) {
  const token = z.union([
    z.enum(["tJPY", "tUSD"]).transform((symbol) => contracts[symbol]),
    address,
  ]);
  app.get("/v1/status", async (c) => c.json(await chain.status()));
  app.get("/v1/blocks", async (c) =>
    c.json(
      await chain.blocks(
        parse(z.object({ limit, before: height.optional() }), c.req.query()),
      ),
    ),
  );
  app.get("/v1/txs", async (c) =>
    c.json(
      await chain.transactions(
        parse(
          page.extend({ address: address.optional(), kind: txKind.optional() }),
          c.req.query(),
        ),
      ),
    ),
  );
  app.get("/v1/txs/:hash", async (c) =>
    c.json(await chain.transaction(parse(hash, c.req.param("hash")))),
  );
  app.get("/v1/registry/accounts", async (c) =>
    c.json(await registry.accounts(parse(accountFilters, c.req.query()))),
  );
  app.get("/v1/registry/accounts/:address", async (c) =>
    c.json(await registry.account(parse(address, c.req.param("address")))),
  );
  app.get("/v1/registry/accounts/:address/at", async (c) =>
    c.json(
      await registry.account(
        parse(address, c.req.param("address")),
        parse(height, c.req.query("block")),
      ),
    ),
  );
  app.get("/v1/registry/vasps", async (c) => c.json(await registry.vasps()));
  app.get("/v1/accounts/:address/transfers", async (c) =>
    c.json(
      await chain.transfers(
        parse(address, c.req.param("address")),
        parse(page.extend({ token: token.optional() }), c.req.query()),
      ),
    ),
  );
  app.get("/v1/accounts/:address/balances", async (c) =>
    c.json(
      await registry.balances(
        parse(address, c.req.param("address")),
        parse(height.optional(), c.req.query("block")),
      ),
    ),
  );
  app.get("/v1/travel-rule/:refId", async (c) =>
    c.json(await chain.travelRule(parse(hash, c.req.param("refId")))),
  );
  app.get("/v1/swaps", async (c) =>
    c.json(
      await chain.swaps(
        parse(address.optional(), c.req.query("address")),
        parse(limit, c.req.query("limit")),
      ),
    ),
  );
  app.get("/v1/safe/:safeTxHash", async (c) =>
    c.json(await chain.safe(parse(hash, c.req.param("safeTxHash")))),
  );
  app.get("/v1/receipt-commitments", async (c) =>
    c.json(await chain.receiptCommitments(parse(limit, c.req.query("limit")))),
  );
}
