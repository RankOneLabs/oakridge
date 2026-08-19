/**
 * Whether an agent session is still needed by the run that started it.
 *
 * Closing a session mid-stage does not merely stop an agent — it abandons the
 * unit. Oakridge's execution workflow gives up the moment its session reports a
 * non-success terminal, so an artifact still parked at a gate is never
 * released, the gate stays approvable in the UI, and the operator's later
 * approval is recorded against a workflow that returned minutes earlier. The
 * run then sits on `required_output_missing` for work the agent had in fact
 * completed.
 *
 * kbbl cannot answer this itself — liveness belongs to Oakridge — so it asks.
 */
export interface SessionHold {
  readonly session_id: string;
  readonly execution_id: string;
  readonly execution_workflow_id: string;
  readonly run_id: string;
  readonly stage_instance_id: string;
  readonly stage_key: string;
  readonly unit_id: string;
}

export interface SessionHoldLookupDeps {
  readonly baseUrl: string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Exported because the refusal body crosses to the PWA: kbbl's own client has
 * to narrow the same shape before it can offer the override, and a second
 * hand-synced copy of this guard is how the two sides drift.
 */
export const isSessionHold = (value: unknown): value is SessionHold => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["session_id", "execution_id", "execution_workflow_id", "run_id", "stage_instance_id", "stage_key", "unit_id"]
    .every((field) => typeof candidate[field] === "string");
};

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

/**
 * The discriminator on a refused close. The one failure of DELETE
 * /sessions/:sid an operator can override, so the client keys the override
 * affordance off this exact literal.
 */
export const SESSION_HELD_CODE = "session_held_by_execution" as const;

/** The refusal an operator sees, naming the work their close would have stranded. */
export const sessionHoldRefusal = (hold: SessionHold) => ({
  error: `session is running stage '${hold.stage_key}' (unit '${hold.unit_id}') for run ${hold.run_id}; closing it now would abandon that unit and strand any artifact waiting at a gate`,
  code: SESSION_HELD_CODE,
  hold,
});

/**
 * Who is asking for the close, which decides whether the hold guard applies.
 *
 * The guard exists to stop a close arriving from *outside* the execution that
 * owns the session. Oakridge tearing down its own unit is the opposite case:
 * the fence is how a cancelled run stops its agent, and it reaches kbbl through
 * the very endpoint the guard protects. Left undistinguished, the two deadlock
 * — the run cannot be cancelled until its session closes, and the session
 * cannot close until the run is no longer active.
 */
export type SessionCloseAuthority =
  /** A human closing a session from the UI. Fully guarded. */
  | { readonly kind: "operator" }
  /** A human who has been shown the refusal and asked again (`?force=1`). */
  | { readonly kind: "operator_override" }
  /** The execution that owns the session, fencing itself (`?fenced_by=`). */
  | { readonly kind: "execution_fence"; readonly execution_id: string };

/**
 * The authority a close request carries.
 *
 * `force` wins over `fenced_by`: an operator who has explicitly overridden
 * should not have their intent narrowed by a stale query param.
 */
export const selectCloseAuthority = (query: {
  readonly force: string | undefined;
  readonly fenced_by: string | undefined;
}): SessionCloseAuthority => {
  if (isTruthyFlag(query.force)) return { kind: "operator_override" };
  if (query.fenced_by !== undefined && query.fenced_by !== "") {
    return { kind: "execution_fence", execution_id: query.fenced_by };
  }
  return { kind: "operator" };
};

/**
 * The refusal this close earns, or null when it may proceed.
 *
 * A fence is honoured only for the execution that actually holds the session.
 * An id that does not match is not a teardown — it is one execution closing
 * another's session, which is the accident the guard was built for.
 */
export const selectCloseRefusal = (
  authority: SessionCloseAuthority,
  hold: SessionHold | null,
): ReturnType<typeof sessionHoldRefusal> | null => {
  if (hold === null) return null;
  if (authority.kind === "operator_override") return null;
  if (authority.kind === "execution_fence" && authority.execution_id === hold.execution_id) return null;
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
