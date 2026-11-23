type Rule = {
  method: "GET" | "POST";
  path: RegExp;
  auth?: "user" | "admin";
  demo?: true;
};
type Service = { url: string; token?: string; rules: Rule[] };
const id = "[A-Za-z0-9_-]+";

const vasp: Rule[] = [
  { method: "POST", path: /^\/v1\/(customers|session)$/ },
  {
    method: "GET",
    path: new RegExp(`^/v1/me(?:/(?:balances|transfers|swaps)(?:/${id})?)?$`),
    auth: "user",
  },
  {
    method: "POST",
    path: /^\/v1\/me\/(transfers|swaps(?:\/quote)?)$/,
    auth: "user",
  },
  {
    method: "GET",
    path: /^\/v1\/admin\/(customers|addresses|travel-rule|alerts|disclosure-requests)$/,
    auth: "admin",
  },
  {
    method: "POST",
    path: new RegExp(
      `^/v1/admin/customers/${id}/(?:kyc/(?:approve|reject)|suspend|reinstate)$`,
    ),
    auth: "admin",
  },
  {
    method: "POST",
    path: new RegExp(
      `^/v1/admin/(?:travel-rule/${id}/(?:approve|reject)|alerts/${id}/(?:request-freeze|close)|disclosure-requests/${id}/(?:approve|reject))$`,
    ),
    auth: "admin",
  },
];

const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i;

type Environment = Readonly<Record<string, string | undefined>>;

function services(env: Environment): Record<string, Service> {
  return {
    "vasp-a": {
      url: env.VASP_A_URL ?? "http://127.0.0.1:8621",
      token: env.VASP_A_ADMIN_TOKEN,
      rules: vasp,
    },
    "vasp-b": {
      url: env.VASP_B_URL ?? "http://127.0.0.1:8622",
      token: env.VASP_B_ADMIN_TOKEN,
      rules: vasp,
    },
    consortium: {
      url: env.CONSORTIUM_URL ?? "http://127.0.0.1:8630",
      token: env.CONSORTIUM_ADMIN_TOKEN,
      rules: [
        { method: "POST", path: /^\/v1\/proposals$/, auth: "admin" },
        { method: "GET", path: new RegExp(`^/v1/proposals(?:/${id})?$`) },
        {
          method: "POST",
          path: new RegExp(`^/v1/proposals/${id}/(?:approve|execute|cancel)$`),
          auth: "admin",
        },
      ],
    },
    indexer: {
      url: env.INDEXER_URL ?? "http://127.0.0.1:8640",
      rules: [
        {
          method: "GET",
          path: /^\/v1\/(status|blocks|txs|swaps|receipt-commitments|registry\/(accounts|vasps))$/,
        },
        {
          method: "GET",
          path: new RegExp(
            `^/v1/(?:txs/${id}|registry/accounts/${id}(?:/at)?|accounts/${id}/(?:transfers|balances)|(?:travel-rule|safe)/${id})$`,
          ),
        },
      ],
    },
    auditor: {
      url: env.AUDITOR_URL ?? "http://127.0.0.1:8650",
      token: env.AUDITOR_ADMIN_TOKEN,
      rules: [
        {
          method: "GET",
          path: /^\/v1\/fifo\/(summary|entries|violations|exclusions)$/,
        },
        { method: "POST", path: /^\/v1\/fifo\/run$/ },
        {
          method: "GET",
          path: /^\/v1\/trace\/0x[0-9a-fA-F]{40}(?:\/balances)?$/,
        },
        {
          method: "GET",
          path: /^\/v1\/disclosures\/ad_[0-9a-f]{32}$/,
          auth: "admin",
        },
        { method: "POST", path: /^\/v1\/disclosures$/, auth: "admin" },
      ],
    },
    gateway: {
      url: env.GATEWAY_URL ?? "http://127.0.0.1:8600",
      rules: [
        {
          method: "GET",
          path: new RegExp(
            `^/v1/(?:log(?:/head)?|status|commitments|receipts/${id})$`,
          ),
        },
        { method: "POST", path: /^\/v1\/receipts\/lookup$/ },
      ],
    },
    demo: {
      url: env.DEMO_TOOLS_URL ?? "http://127.0.0.1:8660",
      token: env.GATEWAY_ADMIN_TOKEN,
      rules: [
        {
          method: "GET",
          path: /^\/v1\/attacker\/(?:status|deposits\/(?:latest|0x[0-9a-fA-F]{64}))$/,
          demo: true,
          auth: "admin",
        },
        {
          method: "POST",
          path: /^\/v1\/attacker\/(?:l1-deposit|l2-send)$/,
          demo: true,
          auth: "admin",
        },

        { method: "GET", path: /^\/v1\/demo\/runs\/current$/, demo: true },
        {
          method: "GET",
          path: /^\/v1\/demo\/state$/,
          auth: "admin",
          demo: true,
        },
        {
          method: "POST",
          path: /^\/v1\/demo\/reorder-next$/,
          auth: "admin",
          demo: true,
        },
        {
          method: "POST",
          path: /^\/v1\/issuer\/mint$/,
          auth: "admin",
          demo: true,
        },
      ],
    },
  };
}

function failure(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function proxyApi(
  request: Request,
  service: string,
  segments: string[],
  env: Environment = process.env,
  send = fetch,
): Promise<Response> {
  if (
    !segments.length ||
    segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    return failure(404, "ROUTE_NOT_FOUND", "API が見つかりません");
  const configured = services(env);
  const target = Object.hasOwn(configured, service)
    ? configured[service]
    : undefined;
  const route = `/${segments.join("/")}`;
  const rule = target?.rules.find(
    (item) => item.method === request.method && item.path.test(route),
  );
  if (!target || !rule || (rule.demo && env.DEMO_MODE !== "true"))
    return failure(404, "ROUTE_NOT_FOUND", "API が見つかりません");
  const requestUrl = new URL(request.url);
  const host = request.headers.get("Host") ?? requestUrl.host;
  if (!localHost.test(host))
    return failure(
      403,
      "HOST_NOT_ALLOWED",
      "localhost からアクセスしてください",
    );
  const origin = `${requestUrl.protocol}//${host.toLowerCase()}`;
  const requestOrigin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (
    request.method !== "GET" &&
    ((requestOrigin && requestOrigin !== origin) || site === "cross-site")
  )
    return failure(403, "ORIGIN_NOT_ALLOWED", "この画面から操作してください");

  const headers = new Headers({ Accept: "application/json" });
  if (rule.auth === "admin") {
    if (!target.token)
      return failure(
        503,
        "ADMIN_UNAVAILABLE",
        "管理 API の設定を確認してください",
      );
    headers.set("Authorization", `Bearer ${target.token}`);
  } else if (rule.auth === "user") {
    const authorization = request.headers.get("Authorization");
    if (!authorization || !/^Bearer [\da-f]{64}$/.test(authorization))
      return failure(401, "UNAUTHORIZED", "ログインしてください");
    headers.set("Authorization", authorization);
  }
  for (const name of [
    "Content-Type",
    "Idempotency-Key",
    "X-Consortium-Member",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const endpoint = new URL(route, target.url);
    endpoint.search = requestUrl.search;
    if (Number(request.headers.get("Content-Length")) > 1_000_000)
      return failure(413, "REQUEST_TOO_LARGE", "送信内容が大きすぎます");
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 1_000_000)
      return failure(413, "REQUEST_TOO_LARGE", "送信内容が大きすぎます");
    const response = await send(endpoint, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(40_000),
    });
    const type = response.headers.get("Content-Type");
    if (response.body && !type?.toLowerCase().startsWith("application/json"))
      return failure(502, "INVALID_UPSTREAM", "サービスの応答形式が違います");
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return failure(503, "SERVICE_UNAVAILABLE", "サービスに接続できません");
  }
}
