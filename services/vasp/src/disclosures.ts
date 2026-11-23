import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import type { serviceApp } from "@ledgera/shared/server";
import { desc, eq } from "drizzle-orm";
import { type Address, bytesToHex, getAddress, isAddress } from "viem";
import { z } from "zod";
import { customers, disclosureRequests, wallets } from "./db/schema.ts";
import { transferBytes } from "./db/transfers.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type Disclosure = typeof disclosureRequests.$inferSelect;
const id = z.string().regex(/^dr_[0-9a-f]{32}$/);
const input = z.object({
  address: z
    .string()
    .refine((value) => isAddress(value), { abort: true })
    .transform((value) => getAddress(value)),
  reason: z.string().trim().min(1).max(500),
  requestedBy: z.literal("auditor"),
});
const missing = () =>
  new ServiceError(
    "DISCLOSURE_NOT_FOUND",
    "Disclosure request does not exist",
    404,
  );
const invalidAddress = () =>
  new ServiceError(
    "DISCLOSURE_ADDRESS_NOT_FOUND",
    "Address has no customer in this VASP",
    404,
  );
const secretHash = (value: string) =>
  createHash("sha256").update(value).digest();

function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ServiceError("INVALID_REQUEST", "Invalid request", 400);
  return result.data;
}

function result(row: Disclosure) {
  if (row.status === "approved" && !row.disclosure)
    throw new Error("Approved disclosure has no snapshot");
  return {
    id: row.id,
    status: row.status,
    ...(row.status === "approved" && { disclosure: row.disclosure }),
  };
}

function adminResult(row: Disclosure) {
  return {
    id: row.id,
    address: getAddress(bytesToHex(row.address)),
    requestedBy: row.requestedBy,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

function registered(database: Pick<Database, "select">, address: Address) {
  return database
    .select({
      id: customers.id,
      familyName: customers.familyName,
      givenName: customers.givenName,
    })
    .from(wallets)
    .innerJoin(customers, eq(customers.id, wallets.customerId))
    .where(eq(wallets.address, transferBytes(address)))
    .limit(1);
}

export function disclosureStore(database: Database) {
  return {
    async create(command: z.infer<typeof input>) {
      const [row] = await database
        .insert(disclosureRequests)
        .values({
          ...command,
          address: transferBytes(command.address),
          status: "pending",
          id: `dr_${randomUUID().replaceAll("-", "")}`,
        })
        .returning();
      return result(row);
    },
    async get(id: string) {
      const [row] = await database
        .select()
        .from(disclosureRequests)
        .where(eq(disclosureRequests.id, id));
      if (!row) throw missing();
      return result(row);
    },
    async list(limit: number) {
      return (
        await database
          .select()
          .from(disclosureRequests)
          .orderBy(
            desc(disclosureRequests.createdAt),
            desc(disclosureRequests.id),
          )
          .limit(limit)
      ).map(adminResult);
    },
    async decide(id: string, status: "approved" | "rejected") {
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(disclosureRequests)
          .where(eq(disclosureRequests.id, id))
          .for("update");
        if (!row) throw missing();
        if (row.status === status) return adminResult(row);
        if (row.status !== "pending")
          throw new ServiceError(
            "DISCLOSURE_ALREADY_DECIDED",
            "Disclosure request already has a decision",
            409,
          );
        let disclosure: Disclosure["disclosure"] = null;
        if (status === "approved") {
          const address = getAddress(bytesToHex(row.address));
          const [customer] = await registered(tx, address);
          if (!customer) throw invalidAddress();
          disclosure = {
            address,
            customerIdentification: customer.id,
            name: {
              primaryIdentifier: customer.familyName,
              secondaryIdentifier: customer.givenName,
            },
          };
        }
        const [changed] = await tx
          .update(disclosureRequests)
          .set({ status, disclosure, decidedAt: new Date() })
          .where(eq(disclosureRequests.id, id))
          .returning();
        return adminResult(changed);
      });
    },
  };
}

export function disclosureRoutes(
  app: ReturnType<typeof serviceApp>,
  store: ReturnType<typeof disclosureStore>,
  auditorKey: string,
) {
  const expected = secretHash(`Bearer ${auditorKey}`);
  function authorize(authorization?: string) {
    if (!timingSafeEqual(expected, secretHash(authorization ?? "")))
      throw new ServiceError("UNAUTHORIZED", "Auditor API key required", 401);
  }

  app.post("/vasp/v1/disclosure-requests", async (context) => {
    authorize(context.req.header("Authorization"));
    return context.json(
      await store.create(
        parse(input, await context.req.json().catch(() => undefined)),
      ),
      201,
    );
  });
  app.get("/vasp/v1/disclosure-requests/:id", async (context) => {
    authorize(context.req.header("Authorization"));
    context.header("Cache-Control", "no-store");
    return context.json(await store.get(parse(id, context.req.param("id"))));
  });
  app.get("/v1/admin/disclosure-requests", async (context) => {
    const limit = parse(
      z.coerce.number().int().min(1).max(100).default(50),
      context.req.query("limit"),
    );
    return context.json({ requests: await store.list(limit) });
  });
  for (const [action, status] of [
    ["approve", "approved"],
    ["reject", "rejected"],
  ] as const) {
    app.post(`/v1/admin/disclosure-requests/:id/${action}`, async (context) =>
      context.json(
        await store.decide(parse(id, context.req.param("id")), status),
      ),
    );
  }
}
