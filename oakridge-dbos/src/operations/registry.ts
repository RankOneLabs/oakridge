import type { CodeOperation } from "../core-client/core-types";
import { PROVIDER_ERROR_CODES } from "../effects/provider-catalog";

/**
 * The code operations a workflow may name (part 1 §2.5), as data. `compile`
 * checks every code worker against it: its inputs must match `input_schema`
 * and the artifact it creates must match `output_schema`. The executor runs
 * each through `createOperationRunner`.
 */
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

export type OperationKey = typeof OPERATION_REGISTRY[number]["key"];
export const OPERATION_KEYS = {
  repository_prepare: OPERATION_REGISTRY[0].key,
  pull_request_observe: OPERATION_REGISTRY[1].key,
} as const satisfies { readonly [name: string]: OperationKey };
