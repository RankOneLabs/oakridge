import type { DecisionTree } from "../../../source-contracts";
import { literal, reference, variant } from "../../../primitives/expressions";

export const github_auth_failure: DecisionTree = { kind: "apply", id: "github_auth_failure", mutations: [], actions: [], outcome: null };

export const begin_build: DecisionTree = {
  kind: "apply",
  id: "begin_build",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_impl", variant: "working", value: literal("unit", {}) }) },
    { kind: "acquire", pool: "implementation_slots" }
  ],
  actions: [{ worker: "build", action: "initial" }],
  outcome: null
};

const build_review: DecisionTree = {
  kind: "apply",
  id: "build_review",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_impl", variant: "review", value: literal("unit", {}) }) }],
  actions: [{ worker: "pr_observer", action: "observe" }],
  outcome: null
};

const build_partial: DecisionTree = { kind: "apply", id: "build_partial", mutations: [], actions: [], outcome: null };

export const build_pair_complete: DecisionTree = {
  kind: "if",
  id: "build_pair_complete",
  condition: {
    kind: "all",
    items: [
      {
        kind: "is_variant",
        value: reference({ kind: "optional_output_revision", key: "build_result", schema: "optional_revision" }, []),
        variant: "some"
      },
      {
        kind: "is_variant",
        value: reference({ kind: "optional_output_revision", key: "pr_summary", schema: "optional_revision" }, []),
        variant: "some"
      }
    ]
  },
  then: build_review,
  otherwise: build_partial
};

const begin_assessment: DecisionTree = {
  kind: "apply",
  id: "begin_assessment",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_impl", variant: "assessing", value: reference({ kind: "trigger" }, []) }) },
    { kind: "revoke", worker: "build" }
  ],
  actions: [{ worker: "assessment", action: "initial" }],
  outcome: null
};

const accept_build_exact_denied: DecisionTree = { kind: "reject", id: "accept_build_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const accept_build_exact: DecisionTree = {
  kind: "if",
  id: "accept_build_exact",
  condition: {
    kind: "all",
    items: [
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["build_result"]),
        right: reference({ kind: "output_revision", key: "build_result", schema: "revision" }, [])
      },
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["pr_summary"]),
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
  then: begin_assessment,
  otherwise: accept_build_exact_denied
};

const build_open_pr_head_absent: DecisionTree = { kind: "reject", id: "build_open_pr_head_absent", error: "invalid_command", detail: "PR head evidence is missing" };

const build_open_pr_head: DecisionTree = {
  kind: "match",
  id: "build_open_pr_head",
  value: reference({ kind: "resource", key: "pull_request" }, ["head_sha"]),
  cases: [{ variant: "some", node: accept_build_exact }],
  otherwise: build_open_pr_head_absent
};

const build_open_pr_denied: DecisionTree = { kind: "reject", id: "build_open_pr_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

export const build_open_pr: DecisionTree = {
  kind: "match",
  id: "build_open_pr",
  value: reference({ kind: "resource", key: "pull_request" }, ["state"]),
  cases: [{ variant: "open", node: build_open_pr_head }],
  otherwise: build_open_pr_denied
};

const revise_build: DecisionTree = {
  kind: "apply",
  id: "revise_build",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_impl", variant: "working", value: literal("unit", {}) }) },
    { kind: "clear_output", key: "build_result" },
    { kind: "clear_output", key: "pr_summary" },
    { kind: "clear_output", key: "assessment" },
    { kind: "revoke", worker: "assessment" },
    { kind: "clear_resource", key: "pull_request" },
    { kind: "revoke", worker: "pr_observer" }
  ],
  actions: [{ worker: "build", action: "revise" }],
  outcome: null
};

const build_feedback_exact_denied: DecisionTree = { kind: "reject", id: "build_feedback_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const build_feedback_exact: DecisionTree = {
  kind: "if",
  id: "build_feedback_exact",
  condition: {
    kind: "all",
    items: [
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["build_result"]),
        right: reference({ kind: "output_revision", key: "build_result", schema: "revision" }, [])
      },
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["pr_summary"]),
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
  then: revise_build,
  otherwise: build_feedback_exact_denied
};

const feedback_open_pr_head_absent: DecisionTree = { kind: "reject", id: "feedback_open_pr_head_absent", error: "invalid_command", detail: "PR head evidence is missing" };

const feedback_open_pr_head: DecisionTree = {
  kind: "match",
  id: "feedback_open_pr_head",
  value: reference({ kind: "resource", key: "pull_request" }, ["head_sha"]),
  cases: [{ variant: "some", node: build_feedback_exact }],
  otherwise: feedback_open_pr_head_absent
};

const feedback_open_pr_denied: DecisionTree = { kind: "reject", id: "feedback_open_pr_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

export const feedback_open_pr: DecisionTree = {
  kind: "match",
  id: "feedback_open_pr",
  value: reference({ kind: "resource", key: "pull_request" }, ["state"]),
  cases: [{ variant: "open", node: feedback_open_pr_head }],
  otherwise: feedback_open_pr_denied
};

const retry_selected: DecisionTree = { kind: "apply", id: "retry_selected", mutations: [], actions: [{ worker: "build", action: "retry" }], outcome: null };

const retry_missing_build_selected: DecisionTree = {
  kind: "apply",
  id: "retry_missing_build_selected",
  mutations: [],
  actions: [{ worker: "build", action: "retry_missing_build" }],
  outcome: null
};

const retry_pr_retention_denied: DecisionTree = { kind: "reject", id: "retry_pr_retention_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const retry_pr_retention: DecisionTree = {
  kind: "match",
  id: "retry_pr_retention",
  value: reference({ kind: "optional_output_revision", key: "pr_summary", schema: "optional_revision" }, []),
  cases: [{ variant: "none", node: retry_selected }, { variant: "some", node: retry_missing_build_selected }],
  otherwise: retry_pr_retention_denied
};

const retry_missing_pr_selected: DecisionTree = { kind: "apply", id: "retry_missing_pr_selected", mutations: [], actions: [{ worker: "build", action: "retry_missing_pr" }], outcome: null };

const retry_no_remaining_output: DecisionTree = { kind: "reject", id: "retry_no_remaining_output", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const retry_remaining_pr_denied: DecisionTree = { kind: "reject", id: "retry_remaining_pr_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const retry_remaining_pr: DecisionTree = {
  kind: "match",
  id: "retry_remaining_pr",
  value: reference({ kind: "optional_output_revision", key: "pr_summary", schema: "optional_revision" }, []),
  cases: [{ variant: "none", node: retry_missing_pr_selected }, { variant: "some", node: retry_no_remaining_output }],
  otherwise: retry_remaining_pr_denied
};

const retry_build_retention_denied: DecisionTree = { kind: "reject", id: "retry_build_retention_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const retry_build_retention: DecisionTree = {
  kind: "match",
  id: "retry_build_retention",
  value: reference({ kind: "optional_output_revision", key: "build_result", schema: "optional_revision" }, []),
  cases: [{ variant: "none", node: retry_pr_retention }, { variant: "some", node: retry_remaining_pr }],
  otherwise: retry_build_retention_denied
};

const retry_retained_exact_denied: DecisionTree = { kind: "reject", id: "retry_retained_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

export const retry_retained_exact: DecisionTree = {
  kind: "if",
  id: "retry_retained_exact",
  condition: {
    kind: "all",
    items: [
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["build_result"]),
        right: reference({ kind: "optional_output_revision", key: "build_result", schema: "optional_revision" }, [])
      },
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["pr_summary"]),
        right: reference({ kind: "optional_output_revision", key: "pr_summary", schema: "optional_revision" }, [])
      }
    ]
  },
  then: retry_build_retention,
  otherwise: retry_retained_exact_denied
};
