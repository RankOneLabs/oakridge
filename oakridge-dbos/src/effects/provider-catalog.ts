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
} as const;

export const PROVIDER_CATALOG = {
  operations: [
    { key: "repository.prepare", version: 1, input_schema: "repo_input", provider_kind: PROVIDER_KINDS.repository,
      input_contract: INPUT_CONTRACTS.repository, settings: ["result_fact"], tools: [],
      recovery: [], emitted_codes: [PROVIDER_ERROR_CODES.worktree_unrecoverable, PROVIDER_ERROR_CODES.head_changed, PROVIDER_ERROR_CODES.invalid_invocation] },
    { key: "session.run", version: 1, input_schema: "session_action", provider_kind: PROVIDER_KINDS.session,
      input_contract: INPUT_CONTRACTS.session, settings: ["evidence_fact"], tools: [],
      recovery: [{ code: PROVIDER_ERROR_CODES.session_failed, fact: PROVIDER_ERROR_CODES.session_failed }],
      emitted_codes: [PROVIDER_ERROR_CODES.session_failed, PROVIDER_ERROR_CODES.invalid_invocation] },
    { key: "pull_request.observe", version: 1, input_schema: "pr_observe_input", provider_kind: PROVIDER_KINDS.pull_request,
      input_contract: INPUT_CONTRACTS.pull_request, settings: ["result_fact"], tools: [],
      recovery: [{ code: PROVIDER_ERROR_CODES.auth, fact: PROVIDER_ERROR_CODES.auth }],
      emitted_codes: [PROVIDER_ERROR_CODES.discovery_unsupported, PROVIDER_ERROR_CODES.auth,
        PROVIDER_ERROR_CODES.provider_rejected, PROVIDER_ERROR_CODES.invalid_invocation] },
    { key: "produce", version: 1, input_schema: "unit", provider_kind: PROVIDER_KINDS.stub,
      input_contract: INPUT_CONTRACTS.stub, settings: ["model"], tools: ["read"], recovery: [], emitted_codes: [] },
  ],
  providers: [
    { kind: PROVIDER_KINDS.repository, input_contract: INPUT_CONTRACTS.repository },
    { kind: PROVIDER_KINDS.session, input_contract: INPUT_CONTRACTS.session },
    { kind: PROVIDER_KINDS.pull_request, input_contract: INPUT_CONTRACTS.pull_request },
    { kind: PROVIDER_KINDS.stub, input_contract: INPUT_CONTRACTS.stub },
  ],
} as const;

export type ProviderKind = typeof PROVIDER_KINDS[keyof typeof PROVIDER_KINDS];
export type InputContract = typeof INPUT_CONTRACTS[keyof typeof INPUT_CONTRACTS];
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[keyof typeof PROVIDER_ERROR_CODES];
