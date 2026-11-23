import { createHash, timingSafeEqual } from "node:crypto";
import { ServiceError } from "@ledgera/shared/errors";
import { verifyHttpRequest } from "@ledgera/shared/http-signature";
import { serviceApp } from "@ledgera/shared/server";
import { z } from "zod";
import { memberInput, proposalInput } from "./proposals.ts";
import type { consortiumChain, Member } from "./safe.ts";
import type { consortiumService } from "./service.ts";

const status = z.enum([
  "open",
  "executable",
  "failed",
  "cancelling",
  "cancelled",
  "executed",
]);
const proposalId = z.string().max(72).startsWith("p_");
const hash = (value: string) => createHash("sha256").update(value).digest();

function parse<T>(schema: z.ZodType<T>, input: unknown) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ServiceError("INVALID_REQUEST", "Invalid request", 400);
  return result.data;
}

function decode(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new ServiceError("INVALID_REQUEST", "Invalid JSON body", 400);
  }
}

export function consortiumApp(
  service: ReturnType<typeof consortiumService>,
  chain: Pick<ReturnType<typeof consortiumChain>, "overview" | "vasp">,
  members: readonly Member[],
  adminToken: string,
) {
  const app = serviceApp("consortium");
  const expected = hash(`Bearer ${adminToken}`);
  const isAdmin = (header?: string) =>
    timingSafeEqual(expected, hash(header ?? ""));

  app.post("/v1/proposals", async (context) => {
    const authorization = context.req.header("Authorization");
    if (isAdmin(authorization)) {
      const input = parse(
        proposalInput,
        await context.req.json().catch(() => undefined),
      );
      const requester = input.requestedBy;
      if (!requester || !("memberId" in requester))
        throw new ServiceError(
          "INVALID_REQUEST",
          "A requesting member is required",
          400,
        );
      return context.json(await service.create(input, requester), 201);
    }

    const signed = await verifyHttpRequest(context.req.raw, chain.vasp);
    const input = parse(proposalInput, decode(signed.body));
    const requester = input.requestedBy;
    if (
      (input.type !== "BLOCK_ACCOUNT" && input.type !== "UNBLOCK_ACCOUNT") ||
      (requester &&
        (!("vaspId" in requester) || requester.vaspId !== signed.vaspId))
    )
      throw new ServiceError(
        "VASP_PROPOSAL_NOT_ALLOWED",
        "VASP cannot make this proposal",
        403,
      );
    return context.json(
      await service.create(input, { vaspId: signed.vaspId }, signed.digest),
      201,
    );
  });

  app.get("/v1/proposals", async (context) =>
    context.json({
      proposals: await service.list(
        parse(status.optional(), context.req.query("status")),
      ),
    }),
  );
  app.get("/v1/proposals/:id", async (context) =>
    context.json(await service.get(parse(proposalId, context.req.param("id")))),
  );

  for (const action of ["approve", "execute"] as const) {
    app.post(`/v1/proposals/:id/${action}`, async (context) => {
      if (!isAdmin(context.req.header("Authorization")))
        throw new ServiceError(
          "UNAUTHORIZED",
          "Consortium admin token required",
          401,
        );
      const id = parse(proposalId, context.req.param("id"));
      const { memberId } = parse(
        memberInput,
        await context.req.json().catch(() => undefined),
      );
      return context.json(await service[action](id, memberId));
    });
  }

  app.get("/v1/members", (context) =>
    context.json({
      members: members.map(({ id, name, account }) => ({
        id,
        name,
        address: account.address,
      })),
    }),
  );
  app.get("/v1/safe", async (context) => {
    const details = await chain.overview();
    return context.json({ ...details, nonce: details.nonce.toString() });
  });

  return app;
}
