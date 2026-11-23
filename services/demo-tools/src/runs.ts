import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { desc, eq, isNotNull } from "drizzle-orm";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { runs } from "./db/schema.ts";
import { exclusive, type mintService } from "./mint.ts";

type Database = Awaited<ReturnType<typeof openDatabase>>;
type Run = typeof runs.$inferSelect;
type Peer = { url: string; adminToken: string };

const people = [
  {
    familyName: "鈴木",
    givenName: "花子",
    name: "suzuki",
    vasp: "A",
    country: "JP",
  },
  {
    familyName: "Lim",
    givenName: "Wei",
    name: "lim",
    vasp: "B",
    country: "SG",
  },
  {
    familyName: "Tan",
    givenName: "Mei",
    name: "tan",
    vasp: "B",
    country: "SG",
  },
  {
    familyName: "Lee",
    givenName: "Jun",
    name: "lee",
    vasp: "B",
    country: "SG",
  },
] as const;
const sequence = z.object({
  seq: z
    .string()
    .regex(/^\d{1,19}$/)
    .transform(BigInt),
});
const customerId = z.string().regex(/^[AB]-[0-9]+$/);
const enrolled = z.object({ id: customerId });
const existing = z.object({
  customers: z.array(
    enrolled.extend({
      email: z.string(),
      familyName: z.string(),
      givenName: z.string(),
    }),
  ),
});
const approved = z.object({
  address: z
    .string()
    .refine((value) => isAddress(value), { abort: true })
    .transform((value) => getAddress(value)),
  kycStatus: z.literal("approved"),
});
const unavailable = () =>
  new ServiceError(
    "DEMO_PEER_UNAVAILABLE",
    "A demo service is unavailable",
    503,
  );

function view(run: Run) {
  return {
    run: run.run,
    startedAt: run.startedAt.toISOString(),
    startSeq: run.startSeq.toString(),
    startBlock: run.startBlock.toString(),
    emailSuffix: `.r${run.run}@example.com`,
  };
}

async function request(url: string, route: string, init?: RequestInit) {
  try {
    const response = await fetch(new URL(route, url), {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  } catch {
    throw unavailable();
  }
}

async function register(
  peer: Peer,
  person: (typeof people)[number],
  run: number,
) {
  const email = `${person.name}.r${run}@example.com`;
  const result = await request(peer.url, "/v1/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      familyName: person.familyName,
      givenName: person.givenName,
      dateOfBirth: "1985-04-01",
      country: person.country,
      addressLine: person.country === "JP" ? "東京都" : "Singapore",
      email,
    }),
  });
  const admin = { Authorization: `Bearer ${peer.adminToken}` };
  let id: string;
  if (result.status === 409) {
    const listed = await request(peer.url, "/v1/admin/customers", {
      headers: admin,
    });
    const data = existing.safeParse(listed.body);
    if (listed.status !== 200 || !data.success) throw unavailable();
    const customer = data.data.customers.find((row) => row.email === email);
    if (
      !customer ||
      customer.familyName !== person.familyName ||
      customer.givenName !== person.givenName
    )
      throw new ServiceError(
        "DEMO_CUSTOMER_CONFLICT",
        "Demo customer email is already in use",
        409,
      );
    id = customer.id;
  } else {
    const customer = enrolled.safeParse(result.body);
    if (result.status !== 201 || !customer.success) throw unavailable();
    id = customer.data.id;
  }
  const status = await request(
    peer.url,
    `/v1/admin/customers/${id}/kyc/approve`,
    {
      method: "POST",
      headers: admin,
    },
  );
  const decision = approved.safeParse(status.body);
  if (status.status !== 200 || !decision.success) throw unavailable();
  return decision.data.address;
}

export function runService(
  database: Database,
  gateway: string,
  peers: Record<"A" | "B", Peer>,
  latest: () => Promise<bigint>,
  mint: ReturnType<typeof mintService>,
) {
  return {
    start() {
      return exclusive(database, "demo-run", async () => {
        const [last] = await database.db
          .select()
          .from(runs)
          .orderBy(desc(runs.run))
          .limit(1);
        let active = last;
        if (!active || active.completedAt) {
          const [head, block] = await Promise.all([
            request(gateway, "/v1/log/head"),
            latest(),
          ]);
          const result = sequence.safeParse(head.body);
          if (head.status !== 200 || !result.success) throw unavailable();
          [active] = await database.db
            .insert(runs)
            .values({
              run: (last?.run ?? 0) + 1,
              startedAt: new Date(),
              startSeq: result.data.seq + 1n,
              startBlock: block + 1n,
            })
            .returning();
        }
        for (const person of people) {
          const to = await register(peers[person.vasp], person, active.run);
          if (person.name === "tan")
            await mint(`run:${active.run}:tan`, {
              token: "tUSD",
              to,
              amount: 1_000_000_000n,
            });
        }
        await database.db
          .update(runs)
          .set({ completedAt: new Date() })
          .where(eq(runs.run, active.run));
        return view(active);
      });
    },
    async current() {
      const [current] = await database.db
        .select()
        .from(runs)
        .where(isNotNull(runs.completedAt))
        .orderBy(desc(runs.run))
        .limit(1);
      if (!current)
        throw new ServiceError("DEMO_RUN_NOT_FOUND", "No demo run exists", 404);
      return view(current);
    },
  };
}
