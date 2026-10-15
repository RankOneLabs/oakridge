/**
 * Provider-owned declarations: the handle kind a live agent session reports,
 * and every failure code the executor or an operation may report on an
 * attempt. This and `operations/registry.ts` are the only declaration sites
 * for these literals.
 */
export const HANDLE_KINDS = {
  session: "kbbl_session",
} as const;

export const PROVIDER_ERROR_CODES = {
  // Declared by the code operations (operations/registry.ts).
  discovery_unsupported: "discovery_unsupported",
  auth: "auth",
  provider_rejected: "provider_rejected",
  pull_request_mismatch: "pull_request_mismatch",
  worktree_unrecoverable: "worktree_unrecoverable",
  head_changed: "head_changed",
  base_branch_missing: "base_branch_missing",
  // The executor's own.
  session_failed: "session_failed",
  session_closed: "session_closed",
  executor_silent_timeout: "executor_silent_timeout",
  kbbl_unconfigured: "kbbl_unconfigured",
  start_rejected: "start_rejected",
  start_attempts_exhausted: "start_attempts_exhausted",
  operation_unavailable: "operation_unavailable",
  output_rejected: "output_rejected",
  invalid_instruction: "invalid_instruction",
  attempt_stopped: "attempt_stopped",
  session_unrecorded: "session_unrecorded",
  carrier_ended: "carrier_ended",
  observation_unavailable: "observation_unavailable",
  execution_deadline_exceeded: "execution_deadline_exceeded",
} as const;

export type HandleKind = typeof HANDLE_KINDS[keyof typeof HANDLE_KINDS];
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[keyof typeof PROVIDER_ERROR_CODES];
