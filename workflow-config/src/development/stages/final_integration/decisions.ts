import type { DecisionTree } from "../../../source-contracts";
import { admissionGate } from "../../run/stage-table";
import { literal, reference, variant } from "../../../primitives/expressions";

const github_auth_failure: DecisionTree = { kind: "apply", id: "github_auth_failure", mutations: [], actions: [], outcome: null };

const final_begin: DecisionTree = {
  kind: "apply",
  id: "final_begin",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_final", variant: "working", value: literal("unit", {}) }) }],
  actions: [{ worker: "integrator", action: "initial" }],
  outcome: null
};

const final_retry: DecisionTree = { kind: "apply", id: "final_retry", mutations: [], actions: [{ worker: "integrator", action: "retry" }], outcome: null };

const final_publication: DecisionTree = { kind: "apply", id: "final_publication", mutations: [], actions: [{ worker: "pr_observer", action: "observe" }], outcome: null };

const final_reviewed: DecisionTree = {
  kind: "apply",
  id: "final_reviewed",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_final", variant: "review", value: reference({ kind: "trigger" }, []) }) },
    { kind: "revoke", worker: "integrator" }
  ],
  actions: [],
  outcome: null
};

const final_review_exact_denied: DecisionTree = { kind: "reject", id: "final_review_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const final_review_exact: DecisionTree = {
  kind: "if",
  id: "final_review_exact",
  condition: {
    kind: "all",
    items: [
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["revision"]),
        right: reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, [])
      },
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["pr_url"]),
        right: reference({ kind: "resource", key: "pull_request" }, ["url"])
      },
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["head_sha"]),
        right: reference({ kind: "resource", key: "pull_request" }, ["head_sha"])
      },
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["pr_url"]),
        right: reference({ kind: "output", key: "pr_summary" }, ["pr_url"])
      }
    ]
  },
  then: final_reviewed,
  otherwise: final_review_exact_denied
};

const final_open_pr_head_absent: DecisionTree = { kind: "reject", id: "final_open_pr_head_absent", error: "invalid_command", detail: "PR head evidence is missing" };

const final_open_pr_head: DecisionTree = {
  kind: "match",
  id: "final_open_pr_head",
  value: reference({ kind: "resource", key: "pull_request" }, ["head_sha"]),
  cases: [{ variant: "some", node: final_review_exact }],
  otherwise: final_open_pr_head_absent
};

const final_open_pr_denied: DecisionTree = { kind: "reject", id: "final_open_pr_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const final_open_pr: DecisionTree = {
  kind: "match",
  id: "final_open_pr",
  value: reference({ kind: "resource", key: "pull_request" }, ["state"]),
  cases: [{ variant: "open", node: final_open_pr_head }],
  otherwise: final_open_pr_denied
};

const final_complete: DecisionTree = {
  kind: "apply",
  id: "final_complete",
  mutations: [{ kind: "export", key: "accepted", value: literal("flag", true) }],
  actions: [],
  outcome: variant({ schema: "result", variant: "complete", value: literal("unit", {}) })
};

const final_closed: DecisionTree = { kind: "apply", id: "final_closed_without_merge",
  mutations: [{ kind: "export", key: "accepted", value: literal("flag", false) }], actions: [],
  outcome: variant({ schema: "result", variant: "complete", value: literal("unit", {}) }) };

const final_close_exact: DecisionTree = { kind: "if", id: "final_close_exact",
  condition: { kind: "all", items: [
    { kind: "equals", left: reference({ kind: "trigger" }, []), right: reference({ kind: "state" }, []) },
    { kind: "equals", left: reference({ kind: "state" }, ["revision"]), right: reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, []) },
    { kind: "equals", left: reference({ kind: "state" }, ["pr_url"]), right: reference({ kind: "resource", key: "pull_request" }, ["url"]) },
    { kind: "equals", left: reference({ kind: "state" }, ["head_sha"]), right: reference({ kind: "resource", key: "pull_request" }, ["head_sha"]) }
  ] }, then: final_closed, otherwise: { ...final_review_exact_denied, id: "final_close_exact_denied" } };

const final_close_context: DecisionTree = { kind: "match", id: "final_close_context", value: reference({ kind: "state" }, []),
  cases: [{ variant: "review", node: { kind: "match", id: "final_close_resource_closed",
    value: reference({ kind: "resource", key: "pull_request" }, ["state"]),
    cases: [{ variant: "closed_unmerged", node: { kind: "match", id: "final_close_head_present",
      value: reference({ kind: "resource", key: "pull_request" }, ["head_sha"]),
      cases: [{ variant: "some", node: final_close_exact }], otherwise: { ...final_review_exact_denied, id: "final_close_head_absent" } } }],
    otherwise: { ...final_review_exact_denied, id: "final_close_resource_denied" } } }],
  otherwise: { ...final_review_exact_denied, id: "final_close_state_denied" } };

const final_close_policy: DecisionTree = { kind: "match", id: "final_close_policy", value: reference({ kind: "input" }, ["final_merge_policy"]),
  cases: [{ variant: "allow_close_without_merge", node: final_close_context }], otherwise: { ...final_review_exact_denied, id: "final_close_policy_denied" } };

const final_merge_exact_denied: DecisionTree = { kind: "reject", id: "final_merge_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const final_merge_exact: DecisionTree = {
  kind: "if",
  id: "final_merge_exact",
  condition: {
    kind: "all",
    items: [
      { kind: "equals", left: reference({ kind: "trigger" }, []), right: reference({ kind: "state" }, []) },
      {
        kind: "equals",
        left: reference({ kind: "state" }, ["revision"]),
        right: reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, [])
      },
      {
        kind: "equals",
        left: reference({ kind: "state" }, ["pr_url"]),
        right: reference({ kind: "resource", key: "pull_request" }, ["url"])
      },
      {
        kind: "equals",
        left: reference({ kind: "state" }, ["head_sha"]),
        right: reference({ kind: "resource", key: "pull_request" }, ["head_sha"])
      }
    ]
  },
  then: final_complete,
  otherwise: final_merge_exact_denied
};

const final_merged_pr_head_absent: DecisionTree = { kind: "reject", id: "final_merged_pr_head_absent", error: "invalid_command", detail: "PR head evidence is missing" };

const final_merged_pr_head: DecisionTree = {
  kind: "match",
  id: "final_merged_pr_head",
  value: reference({ kind: "resource", key: "pull_request" }, ["head_sha"]),
  cases: [{ variant: "some", node: final_merge_exact }],
  otherwise: final_merged_pr_head_absent
};

const final_review_context_denied: DecisionTree = { kind: "reject", id: "final_review_context_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const final_review_context: DecisionTree = {
  kind: "match",
  id: "final_review_context",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "review", node: final_merged_pr_head }],
  otherwise: final_review_context_denied
};

const final_cancel: DecisionTree = {
  kind: "apply",
  id: "final_cancel",
  mutations: [
    { kind: "revoke", worker: "integrator" },
    { kind: "stop", worker: "integrator" },
    { kind: "revoke", worker: "pr_observer" },
    { kind: "stop", worker: "pr_observer" }
  ],
  actions: [],
  outcome: variant({ schema: "result", variant: "cancelled", value: literal("unit", {}) })
};

const final_abandon: DecisionTree = {
  kind: "apply",
  id: "final_abandon",
  mutations: [
    { kind: "revoke", worker: "integrator" },
    { kind: "stop", worker: "integrator" },
    { kind: "revoke", worker: "pr_observer" },
    { kind: "stop", worker: "pr_observer" }
  ],
  actions: [],
  outcome: variant({ schema: "result", variant: "failed", value: literal("unit", {}) })
};

const refresh_pr: DecisionTree = { kind: "apply", id: "refresh_pr", mutations: [], actions: [{ worker: "pr_observer", action: "observe" }], outcome: null };

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

const matching_pr_observation: DecisionTree = {
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

const final_wait: DecisionTree = {
  kind: "wait",
  id: "final_wait",
  continuations: ["review_pr"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "review_pr" }
};

export const final_dispatch: DecisionTree = {
  kind: "match",
  id: "final_dispatch",
  value: reference({ kind: "trigger" }, []),
  cases: [
    { variant: "auth", node: github_auth_failure },
    { variant: "begin", node: admissionGate("final_integration", "phase_final", final_begin) },
    { variant: "admit", node: { ...final_begin, id: "final_integration_admitted" } },
    { variant: "retry", node: final_retry },
    { variant: "submitted", node: final_publication },
    { variant: "review_pr", node: final_open_pr },
    { variant: "confirm_merged", node: final_review_context },
    { variant: "closed_without_merge", node: final_close_policy },
    { variant: "cancel", node: final_cancel },
    { variant: "abandon", node: final_abandon },
    { variant: "session_failed", node: { kind: "apply", id: "final_integration_session_failed", mutations: [{ kind: "set_state", value: variant({ schema: "phase_final", variant: "working", value: literal("unit", {}) }) }], actions: [], outcome: null } },
    { variant: "provider_start_failed", node: { kind: "apply", id: "final_integration_provider_start_failed", mutations: [{ kind: "set_state", value: variant({ schema: "phase_final", variant: "working", value: literal("unit", {}) }) }], actions: [], outcome: null } },
    { variant: "refresh_pr", node: refresh_pr },
    { variant: "pr_observed", node: matching_pr_observation }
  ],
  otherwise: final_wait
};
