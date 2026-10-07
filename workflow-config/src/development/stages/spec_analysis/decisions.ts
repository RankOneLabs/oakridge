import type { DecisionTree } from "../../../source-contracts";
import { literal, reference, variant } from "../../../primitives/expressions";

const spec_analysis_begin: DecisionTree = {
  kind: "apply",
  id: "spec_analysis_begin",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_review", variant: "working", value: literal("unit", {}) }) }],
  actions: [{ worker: "author", action: "initial" }],
  outcome: null
};

const spec_analysis_review: DecisionTree = {
  kind: "apply",
  id: "spec_analysis_review",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_review", variant: "review", value: literal("unit", {}) }) }],
  actions: [],
  outcome: null
};

const spec_analysis_accepted: DecisionTree = {
  kind: "apply",
  id: "spec_analysis_accepted",
  mutations: [
    { kind: "export", key: "accepted", value: literal("flag", true) },
    { kind: "export", key: "body", value: reference({ kind: "output", key: "analysis" }, []) }
  ],
  actions: [],
  outcome: variant({ schema: "result", variant: "complete", value: literal("unit", {}) })
};

const spec_analysis_exact_denied: DecisionTree = { kind: "reject", id: "spec_analysis_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const spec_analysis_exact: DecisionTree = {
  kind: "if",
  id: "spec_analysis_exact",
  condition: {
    kind: "equals",
    left: reference({ kind: "trigger" }, ["revision"]),
    right: reference({ kind: "output_revision", key: "analysis", schema: "revision" }, [])
  },
  then: spec_analysis_accepted,
  otherwise: spec_analysis_exact_denied
};

const spec_analysis_revise: DecisionTree = {
  kind: "apply",
  id: "spec_analysis_revise",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_review", variant: "working", value: literal("unit", {}) }) },
    { kind: "clear_output", key: "analysis" }
  ],
  actions: [{ worker: "author", action: "revise" }],
  outcome: null
};

const spec_analysis_feedback_exact_denied: DecisionTree = {
  kind: "reject",
  id: "spec_analysis_feedback_exact_denied",
  error: "invalid_command",
  detail: "command does not apply to current exact evidence"
};

const spec_analysis_feedback_exact: DecisionTree = {
  kind: "if",
  id: "spec_analysis_feedback_exact",
  condition: {
    kind: "equals",
    left: reference({ kind: "trigger" }, ["revision"]),
    right: reference({ kind: "output_revision", key: "analysis", schema: "revision" }, [])
  },
  then: spec_analysis_revise,
  otherwise: spec_analysis_feedback_exact_denied
};

const spec_analysis_retry: DecisionTree = { kind: "apply", id: "spec_analysis_retry", mutations: [], actions: [{ worker: "author", action: "retry" }], outcome: null };

const spec_analysis_cancel: DecisionTree = {
  kind: "apply",
  id: "spec_analysis_cancel",
  mutations: [{ kind: "revoke", worker: "author" }, { kind: "stop", worker: "author" }],
  actions: [],
  outcome: variant({ schema: "result", variant: "cancelled", value: literal("unit", {}) })
};

const spec_analysis_abandon: DecisionTree = {
  kind: "apply",
  id: "spec_analysis_abandon",
  mutations: [{ kind: "revoke", worker: "author" }, { kind: "stop", worker: "author" }],
  actions: [],
  outcome: variant({ schema: "result", variant: "failed", value: literal("unit", {}) })
};

const spec_analysis_wait: DecisionTree = {
  kind: "wait",
  id: "spec_analysis_wait",
  continuations: ["accept"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "accept" }
};

export const spec_analysis_dispatch: DecisionTree = {
  kind: "match",
  id: "spec_analysis_dispatch",
  value: reference({ kind: "trigger" }, []),
  cases: [
    { variant: "begin", node: spec_analysis_begin },
    { variant: "submitted", node: spec_analysis_review },
    { variant: "accept", node: spec_analysis_exact },
    { variant: "request_changes", node: spec_analysis_feedback_exact },
    { variant: "retry", node: spec_analysis_retry },
    { variant: "cancel", node: spec_analysis_cancel },
    { variant: "abandon", node: spec_analysis_abandon },
    { variant: "session_failed", node: { ...spec_analysis_abandon, id: "spec_analysis_session_failed" } },
  ],
  otherwise: spec_analysis_wait
};
