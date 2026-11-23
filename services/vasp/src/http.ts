import { createHash, timingSafeEqual } from "node:crypto";
import { ServiceError } from "@ledgera/shared/errors";
import { verifyHttpRequest } from "@ledgera/shared/http-signature";
import { serviceApp } from "@ledgera/shared/server";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import type { alertService } from "./alerts.ts";
import type { registryChain } from "./chain.ts";
import type { customerService } from "./customers.ts";
import type { VaspStore } from "./db/store.ts";
import { quoteInput, rfqInput } from "./quote-model.ts";
import type { quoteService } from "./quotes.ts";
import type { swapService } from "./swaps.ts";
import type { transferService } from "./transfers.ts";
import {
  confirmInput,
  refIdInput,
  travelMessage,
} from "./travel-rule-model.ts";
import type { travelRuleService } from "./travel-rules.ts";

const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(200);
const customerInput = z.object({
  familyName: name,
  givenName: name,
  dateOfBirth: z.iso.date(),
  country: z.string().regex(/^[A-Z]{2}$/),
  addressLine: z.string().trim().min(1).max(500),
  email,
});
const customerId = z.string().regex(/^[AB]-\d{6,19}$/);
const transferInput = z.object({
  toAddress: z
    .string()
    .refine((value) => isAddress(value, { strict: false }))
    .transform((value) => getAddress(value.toLowerCase())),
  token: z.enum(["tJPY", "tUSD"]),
  amount: z
    .string()
    .regex(/^\d{1,78}$/)
    .transform(BigInt)
    .refine((amount) => amount > 0n && amount < 1n << 256n),
  beneficiaryName: z
    .object({ primaryIdentifier: name, secondaryIdentifier: name })
    .optional(),
  demo: z.object({ skipChecks: z.boolean() }).optional(),
});
const transferId = z.string().regex(/^tr_[a-zA-Z0-9-]{1,64}$/);
const historyLimit = z.coerce.number().int().positive().max(1000).default(100);
const sessionInput = z.object({ email });
const authHash = (value: string) => createHash("sha256").update(value).digest();

const swapId = z.string().regex(/^q_[0-9a-f]{32}$/);
const swapInput = z.object({
  quoteId: swapId,
  demo: z.object({ allowExpired: z.boolean().optional() }).optional(),
});
function signedJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ServiceError("INVALID_REQUEST", "Invalid JSON body", 400);
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ServiceError("INVALID_REQUEST", "Invalid request", 400);
  return result.data;
}

const registryActions = ["register", "suspend", "reinstate"] as const;

export function vaspApp(
  store: VaspStore,
  service: ReturnType<typeof customerService>,
  chain: Pick<ReturnType<typeof registryChain>, "balances">,
  adminToken: string,
  transfers: ReturnType<typeof transferService>,
  travelRule: ReturnType<typeof travelRuleService>,
  quotes: ReturnType<typeof quoteService>,
  swaps: ReturnType<typeof swapService>,
  alerts: ReturnType<typeof alertService>,
  demoMode: boolean,
) {
  const app = serviceApp("vasp");
  const knownAdmin = authHash(`Bearer ${adminToken}`);

  app.use("/v1/admin/*", async (context, next) => {
    const auth = authHash(context.req.header("Authorization") ?? "");
    if (!timingSafeEqual(knownAdmin, auth)) {
      throw new ServiceError("UNAUTHORIZED", "VASP admin token required", 401);
    }
    await next();
  });

  async function session(authorization: string | undefined) {
    const match = /^Bearer ([0-9a-f]{64})$/.exec(authorization ?? "");
    const id = match && (await store.sessionCustomer(match[1]));
    if (!id)
      throw new ServiceError("UNAUTHORIZED", "Customer session required", 401);
    return store.customer(id);
  }

  app.post("/v1/customers", async (context) => {
    const customer = parse(
      customerInput,
      await context.req.json().catch(() => undefined),
    );
    return context.json(await store.createCustomer(customer), 201);
  });
  app.post("/v1/session", async (context) => {
    const { email } = parse(
      sessionInput,
      await context.req.json().catch(() => undefined),
    );
    return context.json(await store.startSession(email));
  });
  app.get("/v1/me", async (context) =>
    context.json(await session(context.req.header("Authorization"))),
  );
  app.get("/v1/me/balances", async (context) => {
    const customer = await session(context.req.header("Authorization"));
    if (!customer.address) return context.json({ tJPY: "0", tUSD: "0" });
    return context.json(await chain.balances(customer.address));
  });
  app.post("/v1/me/transfers", async (context) => {
    const customer = await session(context.req.header("Authorization"));
    const transfer = parse(
      transferInput,
      await context.req.json().catch(() => undefined),
    );
    if (transfer.demo && !demoMode)
      throw new ServiceError(
        "INVALID_REQUEST",
        "Demo options are disabled",
        400,
      );
    const accepted = await transfers.create(customer.id, {
      to: transfer.toAddress,
      symbol: transfer.token,
      amount: transfer.amount,
      beneficiaryName: transfer.beneficiaryName,
      skipChecks: transfer.demo?.skipChecks ?? false,
      submitOnRevert: demoMode,
    });
    return context.json(accepted, 201);
  });
  app.get("/v1/me/transfers", async (context) => {
    const customer = await session(context.req.header("Authorization"));
    return context.json({
      transfers: await transfers.list(
        customer.id,
        parse(historyLimit, context.req.query("limit")),
      ),
    });
  });
  app.get("/v1/me/transfers/:id", async (context) => {
    const customer = await session(context.req.header("Authorization"));
    return context.json(
      await transfers.get(
        customer.id,
        parse(transferId, context.req.param("id")),
      ),
    );
  });
  app.get("/v1/admin/customers", async (context) =>
    context.json({ customers: await store.listCustomers() }),
  );
  app.get("/v1/admin/addresses", async (context) =>
    context.json({ addresses: await store.addresses() }),
  );
  app.post("/v1/admin/customers/:id/kyc/reject", async (context) =>
    context.json(
      await store.rejectCustomer(parse(customerId, context.req.param("id"))),
    ),
  );
  for (const action of registryActions) {
    const route = action === "register" ? "kyc/approve" : action;
    app.post(`/v1/admin/customers/:id/${route}`, async (context) => {
      const updated = await service.mutate(
        parse(customerId, context.req.param("id")),
        action,
      );
      return context.json({ ...updated.customer, txHash: updated.txHash });
    });
  }
  app.post("/v1/me/swaps/quote", async (context) => {
    const customer = await session(context.req.header("Authorization"));
    if (!customer.address || customer.kycStatus !== "approved")
      throw new ServiceError(
        "KYC_REQUIRED",
        "An approved customer wallet is required",
        403,
      );
    const input = parse(
      quoteInput,
      await context.req.json().catch(() => undefined),
    );
    return context.json(
      await quotes.acquire(customer.id, customer.address, input),
      201,
    );
  });
  app.post("/v1/me/swaps", async (context) => {
    const customer = await session(context.req.header("Authorization"));
    if (!demoMode && (!customer.address || customer.kycStatus !== "approved"))
      throw new ServiceError(
        "KYC_REQUIRED",
        "An approved customer wallet is required",
        403,
      );
    const input = parse(
      swapInput,
      await context.req.json().catch(() => undefined),
    );
    if (input.demo !== undefined && !demoMode)
      throw new ServiceError(
        "DEMO_MODE_DISABLED",
        "Demo mode is disabled",
        403,
      );
    return context.json(
      await swaps.submit(
        customer.id,
        input.quoteId,
        input.demo?.allowExpired === true,
      ),
      201,
    );
  });
  app.get("/v1/me/swaps", async (context) => {
    const customer = await session(context.req.header("Authorization"));
    const limit = parse(
      z.coerce.number().int().min(1).max(100).default(30),
      context.req.query("limit"),
    );
    return context.json({ swaps: await swaps.list(customer.id, limit) });
  });
  app.get("/v1/me/swaps/:id", async (context) => {
    const customer = await session(context.req.header("Authorization"));
    return context.json(
      await swaps.get(customer.id, parse(swapId, context.req.param("id"))),
    );
  });
  app.post("/vasp/v1/rfq/quotes", async (context) => {
    const caller = await verifyHttpRequest(
      context.req.raw,
      travelRule.resolveVasp,
    );
    return context.json(
      await quotes.issue(
        caller.vaspId,
        parse(rfqInput, signedJson(caller.body)),
        caller.digest,
      ),
    );
  });

  const travelRoot = "/vasp/v1/travel-rule/transfers";
  const verified = (request: Request) =>
    verifyHttpRequest(request, travelRule.resolveVasp);

  app.post(travelRoot, async (context) => {
    const identity = await verified(context.req.raw);
    const input = parse(travelMessage, signedJson(identity.body));
    const body = JSON.stringify(
      await travelRule.receive(identity.vaspId, input, identity.timestamp),
    );
    const headers = await travelRule.responseHeaders(
      identity.digest,
      200,
      body,
    );
    return context.body(body, 200, {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
    });
  });
  app.get(`${travelRoot}/:refId`, async (context) => {
    const identity = await verified(context.req.raw);
    const refId = parse(refIdInput, context.req.param("refId"));
    const body = JSON.stringify(await travelRule.get(identity.vaspId, refId));
    const headers = await travelRule.responseHeaders(
      identity.digest,
      200,
      body,
    );
    return context.body(body, 200, {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
    });
  });
  app.post(`${travelRoot}/:refId/confirm`, async (context) => {
    const identity = await verified(context.req.raw);
    const refId = parse(refIdInput, context.req.param("refId"));
    const { txHash } = parse(confirmInput, signedJson(identity.body));
    await travelRule.confirm(identity.vaspId, refId, txHash);
    return context.body(
      null,
      204,
      await travelRule.responseHeaders(identity.digest, 204, ""),
    );
  });
  app.get("/v1/admin/travel-rule", async (context) => {
    const direction = parse(
      z.enum(["in", "out"]).optional(),
      context.req.query("direction"),
    );
    return context.json({ messages: await travelRule.list(direction) });
  });
  for (const action of ["approve", "reject"] as const) {
    app.post(`/v1/admin/travel-rule/:refId/${action}`, async (context) => {
      const refId = parse(refIdInput, context.req.param("refId"));
      return context.json(await travelRule.decide(refId, action));
    });
  }

  const alertId = z.string().regex(/^a_[0-9a-f]{32}$/);
  app.get("/v1/admin/alerts", async (context) => {
    const limit = parse(
      z.coerce.number().int().min(1).max(100).default(50),
      context.req.query("limit"),
    );
    return context.json({ alerts: await alerts.list(limit) });
  });
  app.post("/v1/admin/alerts/:id/request-freeze", async (context) =>
    context.json(await alerts.freeze(parse(alertId, context.req.param("id")))),
  );
  app.post("/v1/admin/alerts/:id/close", async (context) =>
    context.json(await alerts.close(parse(alertId, context.req.param("id")))),
  );
  return app;
}
