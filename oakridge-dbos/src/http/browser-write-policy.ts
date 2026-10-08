import type { MiddlewareHandler } from "hono";
import { matchRoute } from "./routes";

/** Browser writes are identified by the authority's route table. */
export interface BrowserWritePolicy {
  readonly allowed_origins: ReadonlySet<string>;
}

export function browserWritePolicy(origins: readonly string[]): BrowserWritePolicy {
  const allowed_origins = new Set<string>();
  for (const entry of origins) {
    const origin = new URL(entry).origin;
    if (origin !== entry) throw new Error(`OAKRIDGE_ALLOWED_ORIGINS must contain origins: ${entry}`);
    allowed_origins.add(origin);
  }
  return { allowed_origins };
}

export function configuredBrowserWritePolicy(raw = process.env.OAKRIDGE_ALLOWED_ORIGINS): BrowserWritePolicy {
  return browserWritePolicy(raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? []);
}

export function browserWriteRejection(policy: BrowserWritePolicy, request: Pick<Request, "method" | "headers">, path: string): Response | null {
  const route = matchRoute(request.method, path);
  if (!route || route.method === "GET") return null;
  const content_type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (content_type !== "application/json") return Response.json({ error: "JSON content type required" }, { status: 415 });
  const origin = request.headers.get("origin");
  if (origin !== null && !policy.allowed_origins.has(origin)) return Response.json({ error: "origin forbidden" }, { status: 403 });
  return null;
}

export const browserWriteMiddleware = (policy: BrowserWritePolicy): MiddlewareHandler => async (context, next) =>
  browserWriteRejection(policy, context.req.raw, context.req.path) ?? next();
