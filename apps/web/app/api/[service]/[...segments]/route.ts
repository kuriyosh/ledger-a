import { proxyApi } from "../../../../src/api-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ service: string; segments: string[] }> };

async function handle(request: Request, context: Context) {
  const { service, segments } = await context.params;
  return proxyApi(request, service, segments);
}

export { handle as GET, handle as POST };
