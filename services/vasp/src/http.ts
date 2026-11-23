import { createHash, timingSafeEqual } from "node:crypto";
import { ServiceError } from "@ledgera/shared/errors";
import { serviceApp } from "@ledgera/shared/server";
import { z } from "zod";
import type { registryChain } from "./chain.ts";
import type { customerService } from "./customers.ts";
import type { VaspStore } from "./db/store.ts";

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
const sessionInput = z.object({ email });
const authHash = (value: string) => createHash("sha256").update(value).digest();

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
  return app;
}
