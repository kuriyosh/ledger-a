import { serviceApp } from "@ledgera/shared/server";
import { expect, test, vi } from "vitest";
import { demoRoutes } from "../src/routes/demo.ts";

test("guards demo endpoints with the admin token and permits one active reorder", async () => {
  const app = serviceApp("gateway-test");
  const store = {
    armDemo: vi.fn(async () => true),
    demoState: vi.fn(async () => ({
      status: "armed",
      heldSeq: null,
      nextSeq: null,
      heldUntil: null,
    })),
  };
  app.route("/", demoRoutes(store, "test-admin"));
  const path = "/admin/demo/reorder-next";
  await expect(app.request(path, { method: "POST" })).resolves.toMatchObject({
    status: 401,
  });
  await expect(
    app.request("/admin/demo/state", {
      headers: { Authorization: "Bearer incorrect" },
    }),
  ).resolves.toMatchObject({ status: 401 });
  expect(store.armDemo).not.toHaveBeenCalled();
  expect(store.demoState).not.toHaveBeenCalled();
  const headers = { Authorization: "Bearer test-admin" };
  const armed = await app.request(path, { method: "POST", headers });
  expect(armed.status).toBe(200);
  expect(await armed.json()).toMatchObject({ status: "armed" });
  store.armDemo.mockResolvedValueOnce(false);
  const repeat = await app.request(path, { method: "POST", headers });
  expect(repeat.status).toBe(409);
  expect(await repeat.json()).toMatchObject({
    error: { code: "DEMO_REORDER_ACTIVE" },
  });
  await expect(
    app.request("/admin/demo/state", { headers }),
  ).resolves.toMatchObject({ status: 200 });
});
