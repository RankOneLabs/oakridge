// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export const BLOCKER_ARTIFACT = "blocker" as const;
export const BLOCKER_REVIEW = "blocker_review" as const;
export const DECISION_EFFECTS = [
  "approve",
  "request_changes"
] as const;
export const DECISION_OPERATIONS = [
  "approve_assessment",
  "dispatch_feedback",
  "direct_correction",
  "plain"
] as const;
export const OPERATION_KEYS = {
  "repository_prepare": "repository.prepare",
  "pull_request_observe": "pull_request.observe",
  "value_publish": "value.publish",
  "pull_request_inspect": "pull_request.inspect"
} as const;
export const PROVIDER_ERROR_CODES = {
  "discovery_unsupported": "discovery_unsupported",
  "auth": "auth",
  "provider_rejected": "provider_rejected",
  "pull_request_mismatch": "pull_request_mismatch",
  "worktree_unrecoverable": "worktree_unrecoverable",
  "head_changed": "head_changed",
  "session_failed": "session_failed",
  "session_closed": "session_closed",
  "executor_silent_timeout": "executor_silent_timeout",
  "kbbl_unconfigured": "kbbl_unconfigured",
  "start_rejected": "start_rejected",
  "start_attempts_exhausted": "start_attempts_exhausted",
  "operation_unavailable": "operation_unavailable",
  "output_rejected": "output_rejected",
  "invalid_instruction": "invalid_instruction",
  "attempt_stopped": "attempt_stopped",
  "session_unrecorded": "session_unrecorded",
  "carrier_ended": "carrier_ended",
  "observation_unavailable": "observation_unavailable",
  "execution_deadline_exceeded": "execution_deadline_exceeded"
} as const;
export const ROOT_DECLARATION = "$root" as const;
export const VALIDATION_REVIEW = "engine:validator" as const;
