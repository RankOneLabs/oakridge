import type { DecisionTree } from "../../../source-contracts";
import { literal, record, reference, variant } from "../../../primitives/expressions";

const replace_pr: DecisionTree = {
  kind: "apply",
  id: "replace_pr",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_impl", variant: "working", value: literal("unit", {}) }) },
    { kind: "clear_output", key: "build_result" },
    { kind: "clear_output", key: "pr_summary" },
    { kind: "clear_output", key: "assessment" },
    { kind: "revoke", worker: "assessment" },
    { kind: "clear_resource", key: "pull_request" },
    { kind: "revoke", worker: "pr_observer" }
  ],
  actions: [{ worker: "build", action: "replace_pr" }],
  outcome: null
};

const replace_closed_pr_denied: DecisionTree = { kind: "reject", id: "replace_closed_pr_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

export const replace_closed_pr: DecisionTree = {
  kind: "match",
  id: "replace_closed_pr",
  value: reference({ kind: "resource", key: "pull_request" }, ["state"]),
  cases: [{ variant: "closed", node: replace_pr }],
  otherwise: replace_closed_pr_denied
};

const implementation_complete: DecisionTree = {
  kind: "apply",
  id: "implementation_complete",
  mutations: [
    { kind: "release", pool: "implementation_slots" },
    { kind: "export", key: "accepted", value: literal("flag", true) },
    {
      kind: "export",
      key: "integration",
      value: record("integration_seed", [
        { key: "repository_key", value: reference({ kind: "input" }, ["brief", "repository_key"]) },
        { key: "config", value: reference({ kind: "input" }, ["repository", "integration"]) },
        { key: "forge", value: reference({ kind: "input" }, ["repository", "forge"]) },
        { key: "push_remote_owner", value: reference({ kind: "input" }, ["push_remote_owner"]) }
      ])
    },
    {
      kind: "export",
      key: "completed_work",
      value: record("completed_work", [
        { key: "repository_key", value: reference({ kind: "input" }, ["brief", "repository_key"]) },
        { key: "pr_url", value: reference({ kind: "state" }, ["pr_url"]) },
        { key: "head_sha", value: reference({ kind: "state" }, ["head_sha"]) },
        { key: "branch", value: reference({ kind: "output", key: "pr_summary" }, ["branch"]) }
      ])
    }
  ],
  actions: [],
  outcome: variant({ schema: "result", variant: "complete", value: literal("unit", {}) })
};

const merge_exact_denied: DecisionTree = { kind: "reject", id: "merge_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const merge_exact: DecisionTree = {
  kind: "if",
  id: "merge_exact",
  condition: {
    kind: "all",
    items: [
      {
        kind: "equals",
        left: reference({ kind: "state" }, ["pr_url"]),
        right: reference({ kind: "resource", key: "pull_request" }, ["url"])
      },
      {
        kind: "equals",
        left: reference({ kind: "state" }, ["head_sha"]),
        right: reference({ kind: "resource", key: "pull_request" }, ["head_sha"])
      },
      {
        kind: "equals",
        left: reference({ kind: "state" }, ["assessment"]),
        right: reference({ kind: "output_revision", key: "assessment", schema: "revision" }, [])
      },
      {
        kind: "equals",
        left: reference({ kind: "state" }, ["build_result"]),
        right: reference({ kind: "output_revision", key: "build_result", schema: "revision" }, [])
      },
      {
        kind: "equals",
        left: reference({ kind: "state" }, ["pr_summary"]),
        right: reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, [])
      }
    ]
  },
  then: implementation_complete,
  otherwise: merge_exact_denied
};

const merge_resource_head_absent: DecisionTree = { kind: "reject", id: "merge_resource_head_absent", error: "invalid_command", detail: "PR head evidence is missing" };

const merge_resource_head: DecisionTree = {
  kind: "match",
  id: "merge_resource_head",
  value: reference({ kind: "resource", key: "pull_request" }, ["head_sha"]),
  cases: [{ variant: "some", node: merge_exact }],
  otherwise: merge_resource_head_absent
};

const merge_resource_denied: DecisionTree = { kind: "reject", id: "merge_resource_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const merge_resource: DecisionTree = {
  kind: "match",
  id: "merge_resource",
  value: reference({ kind: "resource", key: "pull_request" }, ["state"]),
  cases: [{ variant: "merged", node: merge_resource_head }],
  otherwise: merge_resource_denied
};

const merge_context_denied: DecisionTree = { kind: "reject", id: "merge_context_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

export const merge_context: DecisionTree = {
  kind: "match",
  id: "merge_context",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "awaiting_merge", node: merge_resource }],
  otherwise: merge_context_denied
};

export const refresh_pr: DecisionTree = { kind: "apply", id: "refresh_pr", mutations: [], actions: [{ worker: "pr_observer", action: "observe" }], outcome: null };

const record_pr_observation: DecisionTree = {
  kind: "apply",
  id: "record_pr_observation",
  mutations: [
    {
      kind: "bind_resource",
      key: "pull_request",
      value: {
        kind: "lookup",
        source: reference({ kind: "trigger" }, ["observations"]),
        key_field: "url",
        key: reference({ kind: "output", key: "pr_summary" }, ["pr_url"])
      }
    }
  ],
  actions: [],
  outcome: null
};

const clear_missing_pr_observation: DecisionTree = {
  kind: "apply",
  id: "clear_missing_pr_observation",
  mutations: [{ kind: "clear_resource", key: "pull_request" }],
  actions: [],
  outcome: null
};

export const matching_pr_observation: DecisionTree = {
  kind: "if",
  id: "matching_pr_observation",
  condition: {
    kind: "any",
    items: [
      {
        kind: "not",
        value: {
          kind: "every",
          source: reference({ kind: "trigger" }, ["observations"]),
          predicate: {
            kind: "not",
            value: {
              kind: "equals",
              left: reference({ kind: "item" }, ["url"]),
              right: reference({ kind: "output", key: "pr_summary" }, ["pr_url"])
            }
          }
        }
      }
    ]
  },
  then: record_pr_observation,
  otherwise: clear_missing_pr_observation
};
