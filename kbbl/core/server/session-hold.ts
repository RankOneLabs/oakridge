/**
 * Server-side session-hold policy: asking Oakridge whether a hold exists, and
 * deciding whether a given close may proceed in spite of one.
 *
 * The shape that crosses the wire — `SessionHold`, its guard, and the refusal
 * code — lives in `core/session/session-hold.ts`, because the PWA narrows the
 * same refusal body and must not import a server module to do it.
 */
import { SESSION_HELD_CODE, isSessionHold, type SessionHold } from "../session/session-hold";

export interface SessionHoldLookupDeps {
  readonly baseUrl: string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * The hold on a session, or null when nothing holds it.
 *
 * Deliberately fails open. An unconfigured, unreachable, or erroring Oakridge
 * must not make sessions unclosable — the guard exists to catch an ordinary
 * operator mistake, not to hand a second service veto over kbbl's own
 * lifecycle. A close that slips through when Oakridge is down is recoverable;
 * a kbbl that cannot close sessions because a backend is unhealthy is not.
 */
export const findSessionHold = async (sessionId: string, deps: SessionHoldLookupDeps): Promise<SessionHold | null> => {
  if (!deps.baseUrl) return null;
  const request = deps.fetch ?? globalThis.fetch;
  try {
    const response = await request(`${deps.baseUrl.replace(/\/$/, "")}/session_holds/${encodeURIComponent(sessionId)}`, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const hold = (body as { readonly hold?: unknown }).hold;
    return isSessionHold(hold) ? hold : null;
  } catch {
    return null;
  }
};

/** The refusal an operator sees, naming the work their close would have stranded. */
export const sessionHoldRefusal = (hold: SessionHold) => ({
  error: `session is running worker '${hold.worker}' on unit '${hold.unit_id}' of run ${hold.run_id}; closing it now would strand that attempt`,
  code: SESSION_HELD_CODE,
  hold,
});

/**
 * Who is asking for the close, which decides whether the hold guard applies.
 *
 * The guard stops a close arriving from outside the attempt that holds the
 * session. Oakridge stopping its own attempt is the opposite case and reaches
 * kbbl through the same endpoint, so it names its action: `fenced_by` ends the
 * session for good (a fresh session), `closed_by` leaves it revivable (a
 * resumed one). Left undistinguished, the two would deadlock: the run could
 * not stop its attempt until the session closed, and the session could not
 * close while the attempt ran.
 */
export type SessionCloseAuthority =
  /** A human closing a session from the UI. Fully guarded. */
  | { readonly kind: "operator" }
  /** A human who has been shown the refusal and asked again (`?force=1`). */
  | { readonly kind: "operator_override" }
  /** The attempt that holds the session, closing it (`?fenced_by=` or `?closed_by=`). */
  | { readonly kind: "attempt"; readonly action_id: string };

/** `force` wins: an operator who has explicitly overridden is not narrowed by a stale query param. */
export const selectCloseAuthority = (query: {
  readonly force: string | undefined;
  readonly fenced_by: string | undefined;
  readonly closed_by: string | undefined;
}): SessionCloseAuthority => {
  if (isTruthyFlag(query.force)) return { kind: "operator_override" };
  const action_id = query.fenced_by || query.closed_by;
  return action_id ? { kind: "attempt", action_id } : { kind: "operator" };
};

/**
 * The refusal this close earns, or null when it may proceed. An attempt's
 * close passes only when it is the attempt that holds the session; any other
 * action id is one attempt closing another's session, which the guard is for.
 */
export const selectCloseRefusal = (
  authority: SessionCloseAuthority,
  hold: SessionHold | null,
): ReturnType<typeof sessionHoldRefusal> | null => {
  if (hold === null) return null;
  if (authority.kind === "operator_override") return null;
  if (authority.kind === "attempt" && authority.action_id === hold.action_id) return null;
  return sessionHoldRefusal(hold);
};

/**
 * A URL flag read by the common convention: present and not spelled falsely.
 *
 * Case-folded so `?force=False` is not read as an override.
 */
export const isTruthyFlag = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  const value = raw.toLowerCase();
  return value !== "" && value !== "0" && value !== "false" && value !== "no" && value !== "off";
};
