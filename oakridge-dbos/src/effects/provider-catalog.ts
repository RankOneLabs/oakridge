import type { CodeOperation } from "../core-client/core-types";

/** Provider-owned declarations. This is the only declaration site for provider routing and error codes. */
export const PROVIDER_KINDS = {
  repository: "git",
  session: "kbbl",
  pull_request: "github",
  stub: "stub",
} as const;

export const INPUT_CONTRACTS = {
  repository: "repository_preparation",
  session: "kbbl_session",
  pull_request: "pull_request_observation",
  stub: "unsupported",
} as const;

export const PROVIDER_ERROR_CODES = {
  discovery_unsupported: "discovery_unsupported",
  auth: "auth",
  provider_rejected: "provider_rejected",
  worktree_unrecoverable: "worktree_unrecoverable",
  head_changed: "head_changed",
  invalid_invocation: "invalid_invocation",
  session_failed: "session_failed",
  undeclared_provider_code: "undeclared_provider_code",
  start_rejected: "start_rejected",
  start_attempts_exhausted: "start_attempts_exhausted",
  provider_start_failed: "provider_start_failed",
  provider_not_ported: "provider_not_ported",
  invalid_instruction: "invalid_instruction",
} as const;

export const PROVIDER_CATALOG = {
  operations: [
    { key: "repository.prepare", version: 1, input_schema: "repo_input", provider_kind: PROVIDER_KINDS.repository,
      input_contract: INPUT_CONTRACTS.repository, settings: ["result_fact"], tools: [],
      recovery: [
        { code: PROVIDER_ERROR_CODES.start_rejected, fact: PROVIDER_ERROR_CODES.provider_start_failed },
        { code: PROVIDER_ERROR_CODES.start_attempts_exhausted, fact: PROVIDER_ERROR_CODES.provider_start_failed },
      ], required_recovery_codes: [PROVIDER_ERROR_CODES.start_rejected, PROVIDER_ERROR_CODES.start_attempts_exhausted],
      emitted_codes: [PROVIDER_ERROR_CODES.worktree_unrecoverable, PROVIDER_ERROR_CODES.head_changed,
        PROVIDER_ERROR_CODES.invalid_invocation, PROVIDER_ERROR_CODES.start_rejected, PROVIDER_ERROR_CODES.start_attempts_exhausted] },
    { key: "session.run", version: 1, input_schema: "session_action", provider_kind: PROVIDER_KINDS.session,
      input_contract: INPUT_CONTRACTS.session, settings: ["evidence_fact"], tools: [],
      recovery: [
        { code: PROVIDER_ERROR_CODES.session_failed, fact: PROVIDER_ERROR_CODES.session_failed },
        { code: PROVIDER_ERROR_CODES.start_rejected, fact: PROVIDER_ERROR_CODES.session_failed },
        { code: PROVIDER_ERROR_CODES.start_attempts_exhausted, fact: PROVIDER_ERROR_CODES.session_failed },
      ], required_recovery_codes: [PROVIDER_ERROR_CODES.start_rejected, PROVIDER_ERROR_CODES.start_attempts_exhausted],
      emitted_codes: [PROVIDER_ERROR_CODES.session_failed, PROVIDER_ERROR_CODES.invalid_invocation,
        PROVIDER_ERROR_CODES.start_rejected, PROVIDER_ERROR_CODES.start_attempts_exhausted] },
    { key: "pull_request.observe", version: 1, input_schema: "pr_observe_input", provider_kind: PROVIDER_KINDS.pull_request,
      input_contract: INPUT_CONTRACTS.pull_request, settings: ["result_fact"], tools: [],
      recovery: [
        { code: PROVIDER_ERROR_CODES.auth, fact: PROVIDER_ERROR_CODES.auth },
        { code: PROVIDER_ERROR_CODES.start_rejected, fact: PROVIDER_ERROR_CODES.provider_start_failed },
        { code: PROVIDER_ERROR_CODES.start_attempts_exhausted, fact: PROVIDER_ERROR_CODES.provider_start_failed },
      ],
      required_recovery_codes: [PROVIDER_ERROR_CODES.start_rejected, PROVIDER_ERROR_CODES.start_attempts_exhausted],
      emitted_codes: [PROVIDER_ERROR_CODES.discovery_unsupported, PROVIDER_ERROR_CODES.auth,
        PROVIDER_ERROR_CODES.provider_rejected, PROVIDER_ERROR_CODES.invalid_invocation,
        PROVIDER_ERROR_CODES.start_rejected, PROVIDER_ERROR_CODES.start_attempts_exhausted] },
    { key: "produce", version: 1, input_schema: "unit", provider_kind: PROVIDER_KINDS.stub,
      input_contract: INPUT_CONTRACTS.stub, settings: ["model"], tools: ["read"], recovery: [], emitted_codes: [], required_recovery_codes: [] },
  ],
  providers: [
    { kind: PROVIDER_KINDS.repository, input_contract: INPUT_CONTRACTS.repository },
    { kind: PROVIDER_KINDS.session, input_contract: INPUT_CONTRACTS.session },
    { kind: PROVIDER_KINDS.pull_request, input_contract: INPUT_CONTRACTS.pull_request },
    { kind: PROVIDER_KINDS.stub, input_contract: INPUT_CONTRACTS.stub },
  ],
} as const;

const REPOSITORY_PREPARE = PROVIDER_CATALOG.operations[0];
/**
 * The code operations a workflow may name, as the core checks them when it
 * compiles: a code worker's inputs must match `input_schema` and the artifact
 * it creates must match `output_schema`. The executor runs none of them until
 * the operation registry is wired in (R3).
 */
export const CODE_OPERATIONS: readonly CodeOperation[] = [
  { key: REPOSITORY_PREPARE.key, version: REPOSITORY_PREPARE.version,
    input_schema: { repository_path: "repo_path", expected_head: "optional(text)" },
    output_schema: { repository_path: "repo_path", push_remote_owner: "ident", head: "ident" },
    error_codes: [...REPOSITORY_PREPARE.emitted_codes] },
];

export type ProviderKind = typeof PROVIDER_KINDS[keyof typeof PROVIDER_KINDS];
export type InputContract = typeof INPUT_CONTRACTS[keyof typeof INPUT_CONTRACTS];
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[keyof typeof PROVIDER_ERROR_CODES];
