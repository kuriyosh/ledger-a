import { expect, test, vi } from "vitest";
import { proxyApi } from "../src/api-proxy";

const request = (path: string, init?: RequestInit) =>
  new Request(`http://localhost:3000${path}`, init);

test("attaches the configured admin token and drops response credentials", async () => {
  const send = vi.fn<typeof fetch>(async () =>
    Response.json(
      { customers: [] },
      { headers: { "Set-Cookie": "sensitive=value" } },
    ),
  );
  const response = await proxyApi(
    request("/api/vasp-b/v1/admin/customers?limit=1", {
      headers: { Authorization: "Bearer ignored" },
    }),
    "vasp-b",
    ["v1", "admin", "customers"],
    { VASP_B_URL: "http://vasp-b:8622", VASP_B_ADMIN_TOKEN: "vasp-b-fixture" },
    send,
  );
  expect(await response.json()).toEqual({ customers: [] });
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect(send).toHaveBeenCalledWith(
    new URL("http://vasp-b:8622/v1/admin/customers?limit=1"),
    expect.objectContaining({
      headers: expect.any(Headers),
      redirect: "error",
    }),
  );
  const headers = new Headers(send.mock.calls[0][1]?.headers);
  expect(headers.get("Authorization")).toBe("Bearer vasp-b-fixture");
});

test("blocks direct chain routes and cross-origin admin writes", async () => {
  const send = vi.fn<typeof fetch>();
  const hidden = await proxyApi(
    request("/api/gateway/rpc", { method: "POST" }),
    "gateway",
    ["rpc"],
    {},
    send,
  );
  expect(hidden.status).toBe(404);
  const invalid = await proxyApi(
    request("/api/vasp-a/v1/admin/customers/A-000001/kyc/approve", {
      method: "POST",
      headers: { Origin: "https://unrelated.example" },
    }),
    "vasp-a",
    ["v1", "admin", "customers", "A-000001", "kyc", "approve"],
    { VASP_A_ADMIN_TOKEN: "vasp-a-fixture" },
    send,
  );
  expect(invalid.status).toBe(403);
  expect(send).not.toHaveBeenCalled();
});
