import type { CodeOperation } from "../core-client/core-types";
import { PROVIDER_ERROR_CODES } from "../effects/provider-catalog";

/** Compiler input and output contracts for the two in-process code operations. */
export const OPERATION_REGISTRY = [
  {
    key: "repository.prepare",
    version: 1,
    input_schema: { repository_path: "repo_path", expected_head: "optional(text)" },
    output_schema: { repository_path: "repo_path", push_remote_owner: "ident", head: "ident" },
    error_codes: [PROVIDER_ERROR_CODES.worktree_unrecoverable, PROVIDER_ERROR_CODES.head_changed],
  },
  {
    key: "pull_request.observe",
    version: 1,
    input_schema: { query: { owner: "ident", name: "ident", head_owner: "ident", head_branch: "text", base_branch: "text" } },
    output_schema: { observations: "list({provider: text, owner: ident, name: ident, number: integer, url: text, head_branch: text, base_branch: text, head_sha: optional(text), state: text, source: text, observed_at: text, merged_at: optional(text)})" },
    error_codes: [PROVIDER_ERROR_CODES.discovery_unsupported, PROVIDER_ERROR_CODES.auth, PROVIDER_ERROR_CODES.provider_rejected],
  },
] as const satisfies readonly CodeOperation[];
