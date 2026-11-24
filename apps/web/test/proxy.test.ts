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

test("requires a loopback host before forwarding either admin reads or writes", async () => {
  const send = vi.fn<typeof fetch>();
  const config = { VASP_A_ADMIN_TOKEN: "vasp-a-fixture" };
  const paths = [
    { method: "GET", value: ["v1", "admin", "customers"] },
    {
      method: "POST",
      value: ["v1", "admin", "customers", "A-000001", "kyc", "approve"],
    },
  ];
  for (const { method, value } of paths) {
    const blocked = new Request(
      `http://external.invalid:3000/api/vasp-a/${value.join("/")}`,
      {
        method,
        headers: {
          Host: "external.invalid:3000",
          Origin: "http://external.invalid:3000",
        },
      },
    );
    expect(
      (await proxyApi(blocked, "vasp-a", value, config, send)).status,
    ).toBe(403);
  }
  expect(send).not.toHaveBeenCalled();
});

test("accepts a loopback Host when Next standalone constructs a different internal URL", async () => {
  const sent = vi.fn(async () => Response.json({ indexedBlock: "1" }));
  const result = await proxyApi(
    new Request("http://0.0.0.0:3000/api/indexer/v1/status", {
      headers: { Host: "127.0.0.1:12345" },
    }),
    "indexer",
    ["v1", "status"],
    { INDEXER_URL: "http://indexer:8610" },
    sent,
  );
  expect(result.status).toBe(200);
  expect(sent).toHaveBeenCalledOnce();
});

test("rejects unsafe segments before constructing the upstream URL", async () => {
  const sent = vi.fn(async () => Response.json({}));
  const request = new Request("http://localhost:3000/api/vasp-a/v1/admin");
  const result = await proxyApi(
    request,
    "vasp-a",
    ["v1", "..", "admin"],
    {},
    sent,
  );
  expect(result.status).toBe(404);
  expect(sent).not.toHaveBeenCalled();
});

test("accepts writes from the configured LAN origin", async () => {
  const origin = "http://192.168.100.30:18374";
  const path = ["v1", "session"];
  const send = vi.fn(async () => Response.json({ token: "fixture" }));
  const response = await proxyApi(
    new Request("http://0.0.0.0:3000/api/vasp-a/v1/session", {
      method: "POST",
      headers: { Host: "192.168.100.30:18374", Origin: origin },
    }),
    "vasp-a",
    path,
    { WEB_ALLOWED_ORIGIN: origin },
    send,
  );
  expect(response.status).toBe(200);
  expect(send).toHaveBeenCalledOnce();
});

test("rejects a mismatched port or missing or mismatched origin on LAN writes", async () => {
  const config = { WEB_ALLOWED_ORIGIN: "http://192.168.100.30:18374" };
  const send = vi.fn<typeof fetch>();
  for (const [host, origin] of [
    ["192.168.100.30:18375", "http://192.168.100.30:18375"],
    ["192.168.100.30:18374", "http://unrelated.invalid"],
    ["192.168.100.30:18374", null],
  ] as const) {
    const headers = new Headers({ Host: host });
    if (origin) headers.set("Origin", origin);
    const response = await proxyApi(
      request("/api/vasp-a/v1/session", { method: "POST", headers }),
      "vasp-a",
      ["v1", "session"],
      config,
      send,
    );
    expect(response.status).toBe(403);
  }
  expect(send).not.toHaveBeenCalled();
});
