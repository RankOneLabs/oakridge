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

const isSessionHold = (value: unknown): value is SessionHold => {
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

/** The refusal an operator sees, naming the work their close would have stranded. */
export const sessionHoldRefusal = (hold: SessionHold) => ({
  error: `session is running stage '${hold.stage_key}' (unit '${hold.unit_id}') for run ${hold.run_id}; closing it now would abandon that unit and strand any artifact waiting at a gate`,
  code: "session_held_by_execution" as const,
  hold,
});
