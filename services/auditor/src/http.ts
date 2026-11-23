import { ServiceError } from "@ledgera/shared/errors";
import { logService, serviceApp } from "@ledgera/shared/server";
import { z } from "zod";
import { auditJson } from "./checks.ts";
import type { AuditStore } from "./db/store.ts";
import { uint64 } from "./sources.ts";

const fromSeq = uint64.refine((seq) => seq >= 1n).default(1n);
const filters = z.object({
  fromSeq,
  fromBlock: uint64.refine((block) => block < 1n << 63n).default(0n),
});
const entries = z.object({
  fromSeq,
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

function parse<T>(schema: z.ZodType<T>, data: unknown) {
  const view = schema.safeParse(data);
  if (!view.success)
    throw new ServiceError("INVALID_QUERY", "Invalid FIFO filters", 400);
  return view.data;
}

export function auditorApp(
  store: Pick<
    AuditStore,
    "summary" | "listEntries" | "listViolations" | "listExclusions"
  >,
  run: (reset: boolean) => Promise<void>,
) {
  const app = serviceApp("auditor");
  app.get("/v1/fifo/summary", async (context) =>
    context.json(
      auditJson(await store.summary(parse(filters, context.req.query()))),
    ),
  );
  app.get("/v1/fifo/entries", async (context) => {
    const query = parse(entries, context.req.query());
    return context.json({
      entries: await store.listEntries(query.fromSeq, query.limit),
    });
  });
  app.get("/v1/fifo/violations", async (context) => {
    const rows = await store.listViolations(
      parse(filters, context.req.query()),
    );
    return context.json({ violations: auditJson(rows) });
  });
  app.get("/v1/fifo/exclusions", async (context) => {
    const start = parse(fromSeq, context.req.query("fromSeq"));
    return context.json({
      exclusions: auditJson(await store.listExclusions(start)),
    });
  });
  app.post("/v1/fifo/run", async (context) => {
    try {
      await run(true);
    } catch (error) {
      logService(
        "auditor",
        "error",
        "Unable to complete the requested audit",
        context.get("traceId"),
        {
          errorName: error instanceof Error ? error.name : "Error",
        },
      );
      throw new ServiceError(
        "AUDIT_UNAVAILABLE",
        "Audit inputs are unavailable",
        503,
      );
    }
    return context.json(
      auditJson(await store.summary({ fromSeq: 1n, fromBlock: 0n })),
    );
  });
  return app;
}
