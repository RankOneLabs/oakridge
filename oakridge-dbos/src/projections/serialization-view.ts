import type { MiddlewareHandler } from "hono";

const BEARER = /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/-]+/g;
const HIDDEN_FIELDS = new Set(["publication_secret", "publication_secret_hash"]);

/** The outward JSON view; durable provider bytes are never passed through this transform. */
export function redactingView(value: unknown): unknown {
  if (typeof value === "string") return value.replace(BEARER, "Authorization: Bearer [REDACTED]");
  if (Array.isArray(value)) return value.map(redactingView);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, HIDDEN_FIELDS.has(key) ? "[REDACTED]" : redactingView(item)]));
  return value;
}

/** Central boundary for all JSON reads, including future projections and diagnostics. */
export const redactingReadResponses = (): MiddlewareHandler => async (context, next) => {
  await next();
  if (context.req.method !== "GET" || !context.res.headers.get("content-type")?.startsWith("application/json")) return;
  const value: unknown = await context.res.clone().json();
  const headers = new Headers(context.res.headers);
  headers.delete("content-length");
  context.res = new Response(JSON.stringify(redactingView(value)), { status: context.res.status, headers });
};
