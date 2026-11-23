const token = process.env.GATEWAY_ADMIN_TOKEN;
if (!token) throw new Error("Demo administrator token is required");
const response = await fetch(
  `http://127.0.0.1:${process.env.PORT ?? "8660"}/v1/demo/runs`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(180_000),
  },
);
const text = await response.text();
if (!response.ok) {
  console.error(text);
  process.exitCode = 1;
} else {
  console.log(text);
}
