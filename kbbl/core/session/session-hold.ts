/**
 * The session-hold wire contract, shared by both sides of `DELETE /sessions/:sid`.
 *
 * Server-side policy — who may override a hold, and how kbbl asks Oakridge
 * whether one exists — lives in `core/server/session-hold.ts`. This module is
 * only the shape that crosses the boundary, so the PWA can narrow a refusal
 * without importing a server module.
 */

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

/**
 * Narrows a hold arriving over HTTP — from Oakridge on the server, from a
 * refusal body in the PWA. Shared rather than written twice because a
 * hand-synced second copy is how the two ends of a contract drift apart.
 */
export const isSessionHold = (value: unknown): value is SessionHold => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["session_id", "execution_id", "execution_workflow_id", "run_id", "stage_instance_id", "stage_key", "unit_id"]
    .every((field) => typeof candidate[field] === "string");
};

/**
 * The discriminator on a refused close. The one failure of DELETE
 * /sessions/:sid an operator can override, so the client keys the override
 * affordance off this exact literal.
 */
export const SESSION_HELD_CODE = "session_held_by_execution" as const;
