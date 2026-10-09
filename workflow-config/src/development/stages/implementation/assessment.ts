import type { DecisionTree } from "../../../source-contracts";
import { literal, record, reference, variant } from "../../../primitives/expressions";

const assessment_review: DecisionTree = {
  kind: "apply",
  id: "assessment_review",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_impl", variant: "assessment_review", value: reference({ kind: "state" }, []) }) }],
  actions: [],
  outcome: null
};

const discussion_review: DecisionTree = {
  kind: "apply",
  id: "discussion_review",
  mutations: [
    {
      kind: "set_state",
      value: variant({ schema: "phase_impl", variant: "assessment_review", value: record("build_target", [
        { key: "build_result", value: reference({ kind: "state" }, ["build_result"]) },
        { key: "pr_summary", value: reference({ kind: "state" }, ["pr_summary"]) },
        { key: "pr_url", value: reference({ kind: "state" }, ["pr_url"]) },
        { key: "head_sha", value: reference({ kind: "state" }, ["head_sha"]) }
      ]) })
    }
  ],
  actions: [],
  outcome: null
};

const assessment_submission_context_denied: DecisionTree = {
  kind: "reject",
  id: "assessment_submission_context_denied",
  error: "invalid_command",
  detail: "command does not apply to current exact evidence"
};

export const assessment_submission_context: DecisionTree = {
  kind: "match",
  id: "assessment_submission_context",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "assessing", node: assessment_review }, { variant: "discussing", node: discussion_review }],
  otherwise: assessment_submission_context_denied
};

const await_merge: DecisionTree = {
  kind: "apply",
  id: "await_merge",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_impl", variant: "awaiting_merge", value: reference({ kind: "trigger" }, []) }) }],
  actions: [],
  outcome: null
};

const assessment_exact_denied: DecisionTree = { kind: "reject", id: "assessment_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const assessment_exact: DecisionTree = {
  kind: "if",
  id: "assessment_exact",
  condition: {
    kind: "all",
    items: [
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["assessment"]),
        right: reference({ kind: "output_revision", key: "assessment", schema: "revision" }, [])
      },
      { kind: "equals", left: reference({ kind: "trigger" }, ["build_result"]), right: reference({ kind: "state" }, ["build_result"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["pr_summary"]), right: reference({ kind: "state" }, ["pr_summary"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["pr_url"]), right: reference({ kind: "state" }, ["pr_url"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["head_sha"]), right: reference({ kind: "state" }, ["head_sha"]) },
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
  then: await_merge,
  otherwise: assessment_exact_denied
};

const assessment_open_pr_head_absent: DecisionTree = { kind: "reject", id: "assessment_open_pr_head_absent", error: "invalid_command", detail: "PR head evidence is missing" };

const assessment_open_pr_head: DecisionTree = {
  kind: "match",
  id: "assessment_open_pr_head",
  value: reference({ kind: "resource", key: "pull_request" }, ["head_sha"]),
  cases: [{ variant: "some", node: assessment_exact }],
  otherwise: assessment_open_pr_head_absent
};

const assessment_open_pr_denied: DecisionTree = { kind: "reject", id: "assessment_open_pr_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const assessment_open_pr: DecisionTree = {
  kind: "match",
  id: "assessment_open_pr",
  value: reference({ kind: "resource", key: "pull_request" }, ["state"]),
  cases: [{ variant: "open", node: assessment_open_pr_head }],
  otherwise: assessment_open_pr_denied
};

const assessment_accept_context_denied: DecisionTree = {
  kind: "reject",
  id: "assessment_accept_context_denied",
  error: "invalid_command",
  detail: "command does not apply to current exact evidence"
};

export const assessment_accept_context: DecisionTree = {
  kind: "match",
  id: "assessment_accept_context",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "assessment_review", node: assessment_open_pr }],
  otherwise: assessment_accept_context_denied
};

const discuss_assessment: DecisionTree = {
  kind: "apply",
  id: "discuss_assessment",
  mutations: [
    {
      kind: "set_state",
      value: variant({ schema: "phase_impl", variant: "discussing", value: record("assessment_target", [
        { key: "assessment", value: reference({ kind: "trigger" }, ["assessment"]) },
        { key: "build_result", value: reference({ kind: "trigger" }, ["build_result"]) },
        { key: "pr_summary", value: reference({ kind: "trigger" }, ["pr_summary"]) },
        { key: "pr_url", value: reference({ kind: "trigger" }, ["pr_url"]) },
        { key: "head_sha", value: reference({ kind: "trigger" }, ["head_sha"]) }
      ]) })
    }
  ],
  actions: [{ worker: "assessment", action: "discuss" }],
  outcome: null
};

const discussion_exact_denied: DecisionTree = { kind: "reject", id: "discussion_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const discussion_exact: DecisionTree = {
  kind: "if",
  id: "discussion_exact",
  condition: {
    kind: "all",
    items: [
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["assessment"]),
        right: reference({ kind: "output_revision", key: "assessment", schema: "revision" }, [])
      },
      { kind: "equals", left: reference({ kind: "trigger" }, ["build_result"]), right: reference({ kind: "state" }, ["build_result"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["pr_summary"]), right: reference({ kind: "state" }, ["pr_summary"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["pr_url"]), right: reference({ kind: "state" }, ["pr_url"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["head_sha"]), right: reference({ kind: "state" }, ["head_sha"]) },
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
  then: discuss_assessment,
  otherwise: discussion_exact_denied
};

const discussion_open_pr_head_absent: DecisionTree = { kind: "reject", id: "discussion_open_pr_head_absent", error: "invalid_command", detail: "PR head evidence is missing" };

const discussion_open_pr_head: DecisionTree = {
  kind: "match",
  id: "discussion_open_pr_head",
  value: reference({ kind: "resource", key: "pull_request" }, ["head_sha"]),
  cases: [{ variant: "some", node: discussion_exact }],
  otherwise: discussion_open_pr_head_absent
};

const discussion_open_pr_denied: DecisionTree = { kind: "reject", id: "discussion_open_pr_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const discussion_open_pr: DecisionTree = {
  kind: "match",
  id: "discussion_open_pr",
  value: reference({ kind: "resource", key: "pull_request" }, ["state"]),
  cases: [{ variant: "open", node: discussion_open_pr_head }],
  otherwise: discussion_open_pr_denied
};

const discussion_context_denied: DecisionTree = { kind: "reject", id: "discussion_context_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

export const discussion_context: DecisionTree = {
  kind: "match",
  id: "discussion_context",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "assessment_review", node: discussion_open_pr }],
  otherwise: discussion_context_denied
};

const unchanged_review: DecisionTree = {
  kind: "apply",
  id: "unchanged_review",
  mutations: [
    {
      kind: "set_state",
      value: variant({ schema: "phase_impl", variant: "assessment_review", value: record("build_target", [
        { key: "build_result", value: reference({ kind: "state" }, ["build_result"]) },
        { key: "pr_summary", value: reference({ kind: "state" }, ["pr_summary"]) },
        { key: "pr_url", value: reference({ kind: "state" }, ["pr_url"]) },
        { key: "head_sha", value: reference({ kind: "state" }, ["head_sha"]) }
      ]) })
    }
  ],
  actions: [],
  outcome: null
};

const unchanged_exact_denied: DecisionTree = { kind: "reject", id: "unchanged_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const unchanged_exact: DecisionTree = {
  kind: "if",
  id: "unchanged_exact",
  condition: {
    kind: "all",
    items: [
      { kind: "equals", left: reference({ kind: "trigger" }, ["assessment"]), right: reference({ kind: "state" }, ["assessment"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["build_result"]), right: reference({ kind: "state" }, ["build_result"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["pr_summary"]), right: reference({ kind: "state" }, ["pr_summary"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["pr_url"]), right: reference({ kind: "state" }, ["pr_url"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["head_sha"]), right: reference({ kind: "state" }, ["head_sha"]) },
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["assessment"]),
        right: reference({ kind: "output_revision", key: "assessment", schema: "revision" }, [])
      }
    ]
  },
  then: unchanged_review,
  otherwise: unchanged_exact_denied
};

const unchanged_context_denied: DecisionTree = { kind: "reject", id: "unchanged_context_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

export const unchanged_context: DecisionTree = {
  kind: "match",
  id: "unchanged_context",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "discussing", node: unchanged_exact }],
  otherwise: unchanged_context_denied
};

const implementation_revision: DecisionTree = {
  kind: "apply",
  id: "implementation_revision",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_impl", variant: "working", value: literal("unit", {}) }) },
    { kind: "clear_output", key: "build_result" },
    { kind: "clear_output", key: "pr_summary" },
    { kind: "clear_output", key: "assessment" },
    { kind: "revoke", worker: "assessment" },
    { kind: "clear_resource", key: "pull_request" },
    { kind: "revoke", worker: "pr_observer" }
  ],
  actions: [{ worker: "build", action: "revise_after_assessment" }],
  outcome: null
};

const implementation_feedback_exact_denied: DecisionTree = {
  kind: "reject",
  id: "implementation_feedback_exact_denied",
  error: "invalid_command",
  detail: "command does not apply to current exact evidence"
};

const implementation_feedback_exact: DecisionTree = {
  kind: "if",
  id: "implementation_feedback_exact",
  condition: {
    kind: "all",
    items: [
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["assessment"]),
        right: reference({ kind: "output_revision", key: "assessment", schema: "revision" }, [])
      },
      { kind: "equals", left: reference({ kind: "trigger" }, ["build_result"]), right: reference({ kind: "state" }, ["build_result"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["pr_summary"]), right: reference({ kind: "state" }, ["pr_summary"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["pr_url"]), right: reference({ kind: "state" }, ["pr_url"]) },
      { kind: "equals", left: reference({ kind: "trigger" }, ["head_sha"]), right: reference({ kind: "state" }, ["head_sha"]) },
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
  then: implementation_revision,
  otherwise: implementation_feedback_exact_denied
};

const implementation_feedback_open_pr_head_absent: DecisionTree = { kind: "reject", id: "implementation_feedback_open_pr_head_absent", error: "invalid_command", detail: "PR head evidence is missing" };

const implementation_feedback_open_pr_head: DecisionTree = {
  kind: "match",
  id: "implementation_feedback_open_pr_head",
  value: reference({ kind: "resource", key: "pull_request" }, ["head_sha"]),
  cases: [{ variant: "some", node: implementation_feedback_exact }],
  otherwise: implementation_feedback_open_pr_head_absent
};

const implementation_feedback_open_pr_denied: DecisionTree = {
  kind: "reject",
  id: "implementation_feedback_open_pr_denied",
  error: "invalid_command",
  detail: "command does not apply to current exact evidence"
};

const implementation_feedback_open_pr: DecisionTree = {
  kind: "match",
  id: "implementation_feedback_open_pr",
  value: reference({ kind: "resource", key: "pull_request" }, ["state"]),
  cases: [{ variant: "open", node: implementation_feedback_open_pr_head }],
  otherwise: implementation_feedback_open_pr_denied
};

const implementation_feedback_context_denied: DecisionTree = {
  kind: "reject",
  id: "implementation_feedback_context_denied",
  error: "invalid_command",
  detail: "command does not apply to current exact evidence"
};

export const implementation_feedback_context: DecisionTree = {
  kind: "match",
  id: "implementation_feedback_context",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "assessment_review", node: implementation_feedback_open_pr }],
  otherwise: implementation_feedback_context_denied
};

const assessment_retry: DecisionTree = { kind: "apply", id: "assessment_retry", mutations: [], actions: [{ worker: "assessment", action: "retry" }], outcome: null };

const retry_assessment_context_denied: DecisionTree = {
  kind: "reject",
  id: "retry_assessment_context_denied",
  error: "invalid_command",
  detail: "command does not apply to current exact evidence"
};

export const retry_assessment_context: DecisionTree = {
  kind: "match",
  id: "retry_assessment_context",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "assessing", node: assessment_retry }],
  otherwise: retry_assessment_context_denied
};
