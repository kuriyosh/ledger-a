import { createHash, timingSafeEqual } from "node:crypto";
import { ServiceError } from "@ledgera/shared/errors";
import { Hono } from "hono";
import type { GatewayStore } from "../db/store.ts";

const digest = (token: string) => createHash("sha256").update(token).digest();

export function demoRoutes(
  store: Pick<GatewayStore, "armDemo" | "demoState">,
  token: string,
) {
  const app = new Hono();
  const authorized = digest(`Bearer ${token}`);
  app.use("/admin/demo/*", async (context, next) => {
    const provided = context.req.header("Authorization") ?? "";
    if (!timingSafeEqual(authorized, digest(provided))) {
      throw new ServiceError(
        "UNAUTHORIZED",
        "Gateway admin token required",
        401,
      );
    }
    await next();
  });
  app.post("/admin/demo/reorder-next", async (context) => {
    if (!(await store.armDemo())) {
      throw new ServiceError(
        "DEMO_REORDER_ACTIVE",
        "A demo reorder is already active",
        409,
      );
    }
    return context.json(await store.demoState());
  });
  app.get("/admin/demo/state", async (context) =>
    context.json(await store.demoState()),
  );
  return app;
}
