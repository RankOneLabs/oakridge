import type { CodeOperation } from "../core-client/core-types";
import { PROVIDER_ERROR_CODES } from "../effects/provider-catalog";

/** The name an operation schema uses for a type the workflow chooses (see `compile`'s check 12). */
export const TYPE_VARIABLE = "$value";

const pullRequestQuery = { query: { owner: "ident", name: "ident", head_owner: "ident", head_branch: "text", base_branch: "text", pr_url: "text" } } as const;
const repositoryPrepareErrors = [PROVIDER_ERROR_CODES.worktree_unrecoverable, PROVIDER_ERROR_CODES.head_changed, PROVIDER_ERROR_CODES.provider_rejected];
const pullRequestErrors = [PROVIDER_ERROR_CODES.discovery_unsupported, PROVIDER_ERROR_CODES.auth, PROVIDER_ERROR_CODES.provider_rejected,
  PROVIDER_ERROR_CODES.pull_request_mismatch];

/**
 * The code operations a workflow may name (part 1 §2.5), as data. `compile`
 * checks every code worker against it: its inputs must match `input_schema`
 * and the artifact it creates must match `output_schema`. The executor runs
 * each through `createOperationRunner`.
 */
export const OPERATION_REGISTRY = [
  {
    key: "repository.prepare",
    input_schema: { repository_path: "repo_path", expected_head: "optional(text)", base_branch: "text", integration_branch: "text" },
    output_schema: { repository_path: "repo_path", push_remote_owner: "ident", head: "ident", base_branch: "text" },
    error_codes: repositoryPrepareErrors,
  },
  {
    // Publishes its input as the artifact it creates. `$value` is the type
    // variable `compile` binds to the workflow's type (part 1 §12, R5 E5): it
    // lets an operator review a value that arrived as stage input.
    key: "value.publish",
    input_schema: { value: TYPE_VARIABLE },
    output_schema: TYPE_VARIABLE,
    error_codes: [],
  },
  {
    key: "pull_request.inspect",
    input_schema: pullRequestQuery,
    output_schema: { status: "enum(open, merged, closed_unmerged)", pr_sequence: "integer", observed_link: "text",
      head_sha: "optional(text)", merged_at: "optional(text)" },
    error_codes: pullRequestErrors,
  },
  {
    key: "repository.prepare_checkout",
    input_schema: { repository_path: "repo_path", expected_head: "optional(text)", base_branch: "text", integration_branch: "text" },
    output_schema: { checkout_root: "repo_path", push_remote_owner: "ident", head: "ident", checkout_branch: "text" },
    error_codes: repositoryPrepareErrors,
  },
] as const satisfies readonly CodeOperation[];

export type OperationKey = typeof OPERATION_REGISTRY[number]["key"];
export const OPERATION_KEYS = {
  repository_prepare: OPERATION_REGISTRY[0].key,
  value_publish: OPERATION_REGISTRY[1].key,
  pull_request_inspect: OPERATION_REGISTRY[2].key,
  repository_prepare_checkout: OPERATION_REGISTRY[3].key,
} as const satisfies { readonly [name: string]: OperationKey };
