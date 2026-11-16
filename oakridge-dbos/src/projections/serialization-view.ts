import type { PromptVersionListing, PromptVersionView } from "../http/prompt-versions";
import type { DefinitionDetail, DefinitionPrompts } from "./definition-view";
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

function withOriginalPromptBody(redacted: PromptVersionView, original: PromptVersionView): PromptVersionView {
  return { ...redacted, body: original.body };
}

/** Editable source text is opaque; credential-bearing metadata still uses the normal redactor. */
function redactingPromptVersionListing(listing: PromptVersionListing): PromptVersionListing {
  const redacted = redactingView(listing) as PromptVersionListing;
  return {
    ...redacted,
    published: withOriginalPromptBody(redacted.published, listing.published),
    pending: redacted.pending && listing.pending ? withOriginalPromptBody(redacted.pending, listing.pending) : null,
    versions: redacted.versions.map((version, index) => withOriginalPromptBody(version, listing.versions[index])),
  };
}

/** Pinned prompt bodies are opaque source text whose digest names the exact bytes; the rest of the detail is redacted. */
function redactingDefinitionDetail(detail: DefinitionDetail): DefinitionDetail {
  const redacted = redactingView(detail) as DefinitionDetail;
  const prompts: DefinitionPrompts = Object.fromEntries(Object.entries(redacted.prompts)
    .map(([path, prompt]) => [path, { ...prompt, body: detail.prompts[path].body }]));
  return { ...redacted, prompts };
}

const DEFINITION_DETAIL_PATH = /^\/api\/definitions\/[^/]+$/;

/** Central boundary for all JSON reads, including future projections and diagnostics. */
export const redactingReadResponses = (): MiddlewareHandler => async (context, next) => {
  await next();
  if (context.req.method !== "GET" || !context.res.headers.get("content-type")?.startsWith("application/json")) return;
  // Consume the original rather than a clone: the response is replaced below, and a
  // clone's unread original leaks its whole body in native memory under Bun.
  const value: unknown = await context.res.json();
  const headers = new Headers(context.res.headers);
  headers.delete("content-length");
  // Only successful prompt listings and definition details have the known prompt-body
  // fields. Errors and all other read responses retain full recursive credential redaction.
  const isOk = context.res.status === 200;
  const view = isOk && context.req.path === "/api/prompt-versions" ? redactingPromptVersionListing(value as PromptVersionListing)
    : isOk && DEFINITION_DETAIL_PATH.test(context.req.path) ? redactingDefinitionDetail(value as DefinitionDetail)
    : redactingView(value);
  context.res = new Response(JSON.stringify(view), { status: context.res.status, headers });
};
