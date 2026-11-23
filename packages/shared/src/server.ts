import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { ServiceError } from "./errors.ts";

export const serverEnv = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535),
});

export function serviceApp(service: string) {
  const app = new Hono();
  app.use("*", async (context, next) => {
    const incoming = context.req.header("X-Trace-Id");
    const traceId =
      incoming && /^[a-zA-Z0-9._-]{1,128}$/.test(incoming)
        ? incoming
        : randomUUID();
    const started = performance.now();
    context.header("X-Trace-Id", traceId);
    await next();
    const { status } = context.res;
    console.log(
      JSON.stringify({
        service,
        level: status >= 500 ? "error" : "info",
        msg: context.req.method,
        traceId,
        status,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  });
  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.onError((error, context) => {
    const failure =
      error instanceof ServiceError
        ? error
        : new ServiceError("INTERNAL_ERROR", "Internal server error", 500);
    return context.json(
      {
        error: {
          code: failure.code,
          message: failure.message,
          details: failure.details,
        },
      },
      failure.status,
    );
  });
  return app;
}

export function startService(
  app: { fetch: Parameters<typeof serve>[0]["fetch"] },
  env: z.infer<typeof serverEnv>,
  lifecycle: { onShutdown?: () => void; onClose?: () => Promise<void> } = {},
) {
  const server = serve({
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    lifecycle.onShutdown?.();
    server.close(() => {
      lifecycle.onClose?.().catch(() => {
        process.exitCode = 1;
      });
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
