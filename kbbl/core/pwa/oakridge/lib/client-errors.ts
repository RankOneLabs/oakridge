/**
 * The reason a request failed, in whichever field the route used to say it.
 *
 * The `/api/*` routes answer `{ error: <kind>, detail: <text> }`, the typed
 * domain results answer `{ kind, detail }`, and a rejected ingress answers
 * `{ kind: "rejected", reason }`: the kind ("conflict", "rejected") only
 * classifies the failure, and the detail or reason says what actually went
 * wrong, so they win and the kind is the fallback. `{ error: { ... } }` nests
 * any of these.
 */
export function selectFailureDetail(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const candidate = body as { readonly error?: unknown; readonly detail?: unknown; readonly reason?: unknown; readonly kind?: unknown };
  if (typeof candidate.detail === "string" && candidate.detail.length > 0) return candidate.detail;
  if (typeof candidate.reason === "string" && candidate.reason.length > 0) return candidate.reason;
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
