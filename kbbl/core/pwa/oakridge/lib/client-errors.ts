/**
 * The reason a request failed, in whichever field the route used to say it.
 *
 * The `/api/*` routes answer `{ error: <kind>, detail: <text> }` and the typed
 * domain results answer `{ kind, detail }`: the kind ("conflict",
 * "invalid_payload") only classifies the failure, and the detail says what
 * actually went wrong, so the detail wins and the kind is the fallback.
 * `{ error: { ... } }` nests either shape.
 */
export function selectFailureDetail(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const candidate = body as { readonly error?: unknown; readonly detail?: unknown; readonly kind?: unknown };
  if (typeof candidate.detail === "string" && candidate.detail.length > 0) return candidate.detail;
  if (typeof candidate.error === "object" && candidate.error !== null)
    return selectFailureDetail(candidate.error, fallback);
  if (typeof candidate.error === "string" && candidate.error.length > 0) return candidate.error;
  if (typeof candidate.kind === "string" && candidate.kind.length > 0) return candidate.kind;
  return fallback;
}

/** A received HTTP rejection is distinct from an uncertain network delivery. */
export class OakridgeHttpError extends Error {
  constructor(readonly status: number, detail: string) { super(detail); this.name = "OakridgeHttpError"; }
}

export const isDefinitiveRequestRejection = (cause: unknown): boolean =>
  cause instanceof OakridgeHttpError && cause.status >= 400 && cause.status < 500
    && cause.status !== 408 && cause.status !== 429;
