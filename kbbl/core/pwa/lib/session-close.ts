import {
  SESSION_HELD_CODE,
  isSessionHold,
  type SessionHold,
} from "../../session/session-hold";

/**
 * Why a close did not happen.
 *
 * Mirrors the failure bodies of `DELETE /sessions/:sid`
 * (core/server/handlers/sessions.ts): every one of them carries `error`, and
 * only the attempt-hold refusal (409) adds `code` and the `hold` that
 * explains it. A held session cannot be ended from these listings; the server
 * message names the run and unit that still own it.
 */
export type SessionCloseRefusal =
  | {
      readonly kind: "held_by_attempt";
      readonly message: string;
      readonly hold: SessionHold;
    }
  | { readonly kind: "rejected"; readonly message: string };

/**
 * The refusal a failed close response describes.
 *
 * Pure: takes the already-parsed body so the narrowing is unit-testable
 * without a Response. `body` is whatever the server sent (or null when it sent
 * nothing parseable), hence `unknown`.
 */
export function selectSessionCloseRefusal(
  status: number,
  body: unknown,
): SessionCloseRefusal {
  const fields =
    typeof body === "object" && body !== null
      ? (body as { readonly error?: unknown; readonly code?: unknown; readonly hold?: unknown })
      : null;
  const message =
    typeof fields?.error === "string" && fields.error !== ""
      ? fields.error
      : `session close failed: ${status}`;
  if (fields?.code === SESSION_HELD_CODE && isSessionHold(fields.hold)) {
    return { kind: "held_by_attempt", message, hold: fields.hold };
  }
  return { kind: "rejected", message };
}

/**
 * A refusal carried as a thrown value, so a close stays on the mutation-error
 * path every other kbbl mutation uses while keeping the hold typed.
 */
export class SessionCloseError extends Error {
  readonly refusal: SessionCloseRefusal;

  constructor(refusal: SessionCloseRefusal) {
    super(refusal.message);
    this.name = "SessionCloseError";
    this.refusal = refusal;
  }
}

/** The refusal on a failed close, read at the IO boundary. */
export async function sessionCloseError(res: Response): Promise<SessionCloseError> {
  const body: unknown = await res.json().catch(() => null);
  return new SessionCloseError(selectSessionCloseRefusal(res.status, body));
}
