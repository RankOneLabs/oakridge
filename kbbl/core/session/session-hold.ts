/**
 * The session-hold wire contract, shared by both sides of `DELETE /sessions/:sid`.
 *
 * Server-side policy (who may close a held session, and how kbbl asks Oakridge
 * whether a hold exists) lives in `core/server/session-hold.ts`. This module is
 * only the shape that crosses the boundary, so the PWA can narrow a refusal
 * without importing a server module.
 */
import type { OperatorSessionHold } from "../pwa/oakridge/operator-contracts";

/**
 * The running Oakridge attempt that still uses a session. Closing it would
 * strand the attempt: its worker can no longer publish, and the run waits on
 * work the agent may already have done. kbbl cannot know this itself, so it
 * asks Oakridge (`GET /session_holds/:session_id`).
 */
export type SessionHold = OperatorSessionHold;

/** Narrows a hold arriving over HTTP: from Oakridge on the server, from a refusal body in the PWA. */
export const isSessionHold = (value: unknown): value is SessionHold => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly [field: string]: unknown };
  return ["session_id", "run_id", "unit_id", "worker", "action_id"].every((field) => typeof candidate[field] === "string");
};

/**
 * The discriminator on a refused close: the one failure of
 * `DELETE /sessions/:sid` an operator can override, so the client keys the
 * override affordance off this exact literal.
 */
export const SESSION_HELD_CODE = "session_held_by_attempt" as const;
