/**
 * The reason a request failed, in whichever field the route used to say it.
 *
 * Most routes answer `{ error }`, but the typed domain results answer
 * `{ kind, detail }` — a refused run delete says
 * `{ kind: "active_conflict", detail: "run has an active DBOS workflow attempt" }`.
 * Reading only `error` threw that away and showed a bare status code, so a
 * delete that the server had explained precisely looked to the operator like it
 * was simply broken.
 */
export function selectFailureDetail(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const candidate = body as { readonly error?: unknown; readonly detail?: unknown; readonly kind?: unknown };
  if (typeof candidate.error === "string" && candidate.error.length > 0) return candidate.error;
  if (typeof candidate.error === "object" && candidate.error !== null)
    return selectFailureDetail(candidate.error, fallback);
  if (typeof candidate.detail === "string" && candidate.detail.length > 0) return candidate.detail;
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
