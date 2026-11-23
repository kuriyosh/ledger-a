import { randomUUID } from "node:crypto";
import type { openDatabase } from "@ledgera/shared/db";
import { ServiceError } from "@ledgera/shared/errors";
import { eq } from "drizzle-orm";
import { type Address, getAddress, isAddress } from "viem";
import { z } from "zod";
import { disclosures } from "./db/schema.ts";

const address = z
  .string()
  .refine((value) => isAddress(value), { abort: true })
  .transform((value) => getAddress(value));
const height = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) < 1n << 63n);
const unsigned = z.string().regex(/^\d+$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const localId = z.string().regex(/^ad_[0-9a-f]{32}$/);
const remoteId = z.string().regex(/^dr_[0-9a-f]{32}$/);

const registryEntry = z.object({
  address,
  vaspId: z.int().nonnegative(),
  kind: z.int().nonnegative(),
  status: z.int().nonnegative(),
  validUntil: unsigned,
  version: unsigned.optional(),
  blockNumber: height.optional(),
  logIndex: z.int().nonnegative().optional(),
  txHash: hash.optional(),
  actor: address.optional(),
  reason: hash.optional(),
});
const registryReply = z.object({
  address,
  blockNumber: height,
  account: registryEntry,
  history: z.array(registryEntry),
  nextBefore: z.string().nullable().optional(),
});
const transfersReply = z.object({
  transfers: z.array(
    z.object({
      blockNumber: height,
      logIndex: z.int().nonnegative(),
      txHash: hash,
      token: address,
      from: address,
      to: address,
      amount: unsigned,
      travelRuleRef: hash.nullable(),
    }),
  ),
  nextBefore: z.string().nullable(),
});
const balancesReply = z.object({
  address,
  blockNumber: height,
  balances: z.object({ tJPY: unsigned, tUSD: unsigned }),
});
const peersReply = z.object({
  vasps: z.array(
    z.object({ vaspId: z.int().nonnegative(), endpoint: z.string() }),
  ),
});
const requested = z.object({
  address,
  reason: z.string().trim().min(1).max(500),
});
const requestReply = z.object({ id: remoteId, status: z.literal("pending") });
const disclosureReply = z.discriminatedUnion("status", [
  z.object({ id: remoteId, status: z.literal("pending") }),
  z.object({ id: remoteId, status: z.literal("rejected") }),
  z.object({
    id: remoteId,
    status: z.literal("approved"),
    disclosure: z.object({
      address,
      customerIdentification: z.string().min(1),
      name: z.object({
        primaryIdentifier: z.string(),
        secondaryIdentifier: z.string(),
      }),
    }),
  }),
]);

type Database = Awaited<ReturnType<typeof openDatabase>>["db"];
type Peer = { url: string; apiKey: string };
type App = ReturnType<typeof import("@ledgera/shared/server").serviceApp>;

function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ServiceError(
      "INVALID_REQUEST",
      "Invalid trace or disclosure request",
      400,
    );
  return result.data;
}

export function traceRoutes(
  app: App,
  db: Database,
  indexer: string,
  peers: ReadonlyMap<number, Peer>,
  send = fetch,
) {
  async function request<T>(
    base: string,
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ) {
    try {
      const response = await send(new URL(path, base), {
        ...init,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("Upstream unavailable");
      return schema.parse(await response.json());
    } catch {
      throw new ServiceError(
        "TRACE_SOURCE_UNAVAILABLE",
        "Indexer or VASP response unavailable",
        503,
      );
    }
  }

  function readRegistry(account: Address) {
    return request(indexer, `/v1/registry/accounts/${account}`, registryReply);
  }

  async function target(id: number) {
    const peer = peers.get(id);
    if (!peer)
      throw new ServiceError(
        "DISCLOSURE_VASP_UNAVAILABLE",
        "No disclosure endpoint configured for the VASP",
        409,
      );
    const { vasps } = await request(indexer, "/v1/registry/vasps", peersReply);
    const endpoint = vasps.find(
      (candidate) => candidate.vaspId === id,
    )?.endpoint;
    let origin: string | undefined;
    try {
      origin = endpoint ? new URL(endpoint).origin : undefined;
    } catch {}
    if (origin !== new URL(peer.url).origin)
      throw new ServiceError(
        "DISCLOSURE_VASP_UNAVAILABLE",
        "Registry endpoint does not match the configured VASP",
        409,
      );
    return peer;
  }

  app.get("/v1/trace/:address", async (context) => {
    const account = parse(address, context.req.param("address"));
    const registry = await readRegistry(account);
    const next = BigInt(registry.blockNumber) + 1n;
    const [balances, transfers] = await Promise.all([
      request(
        indexer,
        `/v1/accounts/${account}/balances?block=${registry.blockNumber}`,
        balancesReply,
      ),
      request(
        indexer,
        `/v1/accounts/${account}/transfers?before=${next}`,
        transfersReply,
      ),
    ]);
    return context.json({
      address: account,
      blockNumber: registry.blockNumber,
      registry: registry.account,
      history: registry.history,
      balances: balances.balances,
      transfers: transfers.transfers,
      nextHistory: registry.nextBefore ?? null,
      nextTransfer: transfers.nextBefore,
    });
  });
  app.get("/v1/trace/:address/balances", async (context) => {
    const account = parse(address, context.req.param("address"));
    const block = parse(height.optional(), context.req.query("block"));
    return context.json(
      await request(
        indexer,
        `/v1/accounts/${account}/balances${block === undefined ? "" : `?block=${block}`}`,
        balancesReply,
      ),
    );
  });
  app.post("/v1/disclosures", async (context) => {
    const input = parse(
      requested,
      await context.req.json().catch(() => undefined),
    );
    const registry = await readRegistry(input.address);
    const vaspId = registry.account.vaspId;
    const peer = await target(vaspId);
    const remote = await request(
      peer.url,
      "/vasp/v1/disclosure-requests",
      requestReply,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${peer.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...input, requestedBy: "auditor" }),
      },
    );
    const id = `ad_${randomUUID().replaceAll("-", "")}`;
    await db.insert(disclosures).values({
      id,
      address: input.address,
      reason: input.reason,
      vaspId,
      vaspRequestId: remote.id,
      status: remote.status,
    });
    return context.json({ id, status: remote.status }, 201);
  });
  app.get("/v1/disclosures/:id", async (context) => {
    const id = parse(localId, context.req.param("id"));
    const [row] = await db
      .select()
      .from(disclosures)
      .where(eq(disclosures.id, id));
    if (!row)
      throw new ServiceError(
        "DISCLOSURE_NOT_FOUND",
        "Disclosure request not found",
        404,
      );
    const peer = await target(row.vaspId);
    const remote = await request(
      peer.url,
      `/vasp/v1/disclosure-requests/${row.vaspRequestId}`,
      disclosureReply,
      {
        headers: { Authorization: `Bearer ${peer.apiKey}` },
      },
    );
    if (
      remote.id !== row.vaspRequestId ||
      (remote.status === "approved" &&
        remote.disclosure.address !== row.address)
    )
      throw new ServiceError(
        "TRACE_SOURCE_UNAVAILABLE",
        "Disclosure response did not match the request",
        503,
      );
    if (remote.status !== row.status)
      await db
        .update(disclosures)
        .set({ status: remote.status })
        .where(eq(disclosures.id, id));
    context.header("Cache-Control", "no-store");
    return context.json({
      id,
      status: remote.status,
      ...(remote.status === "approved" && { disclosure: remote.disclosure }),
    });
  });
}
