import { setTimeout } from "node:timers/promises";

const origin = process.env.LEDGERA_WEB_URL ?? "http://127.0.0.1:3000";

export async function api<T>(
  service: string,
  path: string,
  options: {
    body?: object;
    token?: string;
    method?: "POST";
    status?: number;
  } = {},
): Promise<T> {
  const response = await fetch(new URL(`/api/${service}${path}`, origin), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      Accept: "application/json",
      ...(options.body && { "Content-Type": "application/json" }),
      ...(options.token && { Authorization: `Bearer ${options.token}` }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await response.json();
  if (
    options.status === undefined
      ? !response.ok
      : response.status !== options.status
  ) {
    throw new Error(
      `${service + path} returned ${response.status} (${data?.error?.code ?? "unexpected response"})`,
    );
  }
  return data as T;
}

export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  message: string,
  timeout = 30_000,
) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result !== undefined) return result;
    await setTimeout(300);
  } while (Date.now() < deadline);
  throw new Error(message);
}
