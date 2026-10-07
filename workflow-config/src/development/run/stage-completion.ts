import type { DecisionTree } from "../../source-contracts";
import { literal, record, reference, variant } from "../../primitives/expressions";

const prepare_advance: DecisionTree = {
  kind: "apply",
  id: "prepare_advance",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_root", variant: "analyzing", value: literal("unit", {}) }) },
    { kind: "activate_child", key: "analysis" }
  ],
  actions: [],
  outcome: null
};

const prepare_failure: DecisionTree = {
  kind: "apply",
  id: "prepare_failure",
  mutations: [
    { kind: "cancel_children", key: "prepare" },
    { kind: "cancel_children", key: "analysis" },
    { kind: "cancel_children", key: "plan" },
    { kind: "cancel_children", key: "briefs" },
    { kind: "cancel_children", key: "implementation" },
    { kind: "cancel_children", key: "integration" }
  ],
  actions: [],
  outcome: variant({ schema: "run_result", variant: "failed", value: record("failure_summary", [
    {
      key: "failures",
      value: {
        kind: "filter",
        source: reference({ kind: "children_outcomes", key: "prepare", schema: "results" }, []),
        predicate: { kind: "not", value: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" } }
      }
    },
    { key: "prior_failures", value: literal("results", []) }
  ]) })
};

const prepare_success: DecisionTree = {
  kind: "if",
  id: "prepare_success",
  condition: {
    kind: "every",
    source: reference({ kind: "children_outcomes", key: "prepare", schema: "results" }, []),
    predicate: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" }
  },
  then: prepare_advance,
  otherwise: prepare_failure
};

const prepare_pending: DecisionTree = {
  kind: "wait",
  id: "prepare_pending",
  continuations: ["prepare_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "prepare_finished" }
};

const prepare_all_terminal: DecisionTree = {
  kind: "if",
  id: "prepare_all_terminal",
  condition: reference({ kind: "children_complete", key: "prepare", schema: "flag" }, []),
  then: prepare_success,
  otherwise: prepare_pending
};

const prepare_stale: DecisionTree = {
  kind: "wait",
  id: "prepare_stale",
  continuations: ["prepare_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "prepare_finished" }
};

export const prepare_parent_phase: DecisionTree = {
  kind: "match",
  id: "prepare_parent_phase",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "preparing", node: prepare_all_terminal }],
  otherwise: prepare_stale
};

const analysis_advance: DecisionTree = {
  kind: "apply",
  id: "analysis_advance",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_root", variant: "planning", value: literal("unit", {}) }) },
    { kind: "activate_child", key: "plan" }
  ],
  actions: [],
  outcome: null
};

const analysis_failure: DecisionTree = {
  kind: "apply",
  id: "analysis_failure",
  mutations: [
    { kind: "cancel_children", key: "prepare" },
    { kind: "cancel_children", key: "analysis" },
    { kind: "cancel_children", key: "plan" },
    { kind: "cancel_children", key: "briefs" },
    { kind: "cancel_children", key: "implementation" },
    { kind: "cancel_children", key: "integration" }
  ],
  actions: [],
  outcome: variant({ schema: "run_result", variant: "failed", value: record("failure_summary", [
    {
      key: "failures",
      value: {
        kind: "filter",
        source: reference({ kind: "children_outcomes", key: "analysis", schema: "results" }, []),
        predicate: { kind: "not", value: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" } }
      }
    },
    { key: "prior_failures", value: literal("results", []) }
  ]) })
};

const analysis_success: DecisionTree = {
  kind: "if",
  id: "analysis_success",
  condition: {
    kind: "every",
    source: reference({ kind: "children_outcomes", key: "analysis", schema: "results" }, []),
    predicate: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" }
  },
  then: analysis_advance,
  otherwise: analysis_failure
};

const analysis_pending: DecisionTree = {
  kind: "wait",
  id: "analysis_pending",
  continuations: ["analysis_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "analysis_finished" }
};

const analysis_all_terminal: DecisionTree = {
  kind: "if",
  id: "analysis_all_terminal",
  condition: reference({ kind: "children_complete", key: "analysis", schema: "flag" }, []),
  then: analysis_success,
  otherwise: analysis_pending
};

const analysis_stale: DecisionTree = {
  kind: "wait",
  id: "analysis_stale",
  continuations: ["analysis_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "analysis_finished" }
};

export const analysis_parent_phase: DecisionTree = {
  kind: "match",
  id: "analysis_parent_phase",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "analyzing", node: analysis_all_terminal }],
  otherwise: analysis_stale
};

const plan_advance: DecisionTree = {
  kind: "apply",
  id: "plan_advance",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_root", variant: "briefing", value: literal("unit", {}) }) },
    { kind: "activate_child", key: "briefs" }
  ],
  actions: [],
  outcome: null
};

const plan_failure: DecisionTree = {
  kind: "apply",
  id: "plan_failure",
  mutations: [
    { kind: "cancel_children", key: "prepare" },
    { kind: "cancel_children", key: "analysis" },
    { kind: "cancel_children", key: "plan" },
    { kind: "cancel_children", key: "briefs" },
    { kind: "cancel_children", key: "implementation" },
    { kind: "cancel_children", key: "integration" }
  ],
  actions: [],
  outcome: variant({ schema: "run_result", variant: "failed", value: record("failure_summary", [
    {
      key: "failures",
      value: {
        kind: "filter",
        source: reference({ kind: "children_outcomes", key: "plan", schema: "results" }, []),
        predicate: { kind: "not", value: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" } }
      }
    },
    { key: "prior_failures", value: literal("results", []) }
  ]) })
};

const plan_success: DecisionTree = {
  kind: "if",
  id: "plan_success",
  condition: {
    kind: "every",
    source: reference({ kind: "children_outcomes", key: "plan", schema: "results" }, []),
    predicate: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" }
  },
  then: plan_advance,
  otherwise: plan_failure
};

const plan_pending: DecisionTree = {
  kind: "wait",
  id: "plan_pending",
  continuations: ["plan_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "plan_finished" }
};

const plan_all_terminal: DecisionTree = {
  kind: "if",
  id: "plan_all_terminal",
  condition: reference({ kind: "children_complete", key: "plan", schema: "flag" }, []),
  then: plan_success,
  otherwise: plan_pending
};

const plan_stale: DecisionTree = {
  kind: "wait",
  id: "plan_stale",
  continuations: ["plan_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "plan_finished" }
};

export const plan_parent_phase: DecisionTree = {
  kind: "match",
  id: "plan_parent_phase",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "planning", node: plan_all_terminal }],
  otherwise: plan_stale
};

const briefs_advance: DecisionTree = {
  kind: "apply",
  id: "briefs_advance",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_root", variant: "implementing", value: literal("unit", {}) }) },
    { kind: "activate_child", key: "implementation" }
  ],
  actions: [],
  outcome: null
};

const briefs_failure: DecisionTree = {
  kind: "apply",
  id: "briefs_failure",
  mutations: [
    { kind: "cancel_children", key: "prepare" },
    { kind: "cancel_children", key: "analysis" },
    { kind: "cancel_children", key: "plan" },
    { kind: "cancel_children", key: "briefs" },
    { kind: "cancel_children", key: "implementation" },
    { kind: "cancel_children", key: "integration" }
  ],
  actions: [],
  outcome: variant({ schema: "run_result", variant: "failed", value: record("failure_summary", [
    {
      key: "failures",
      value: {
        kind: "filter",
        source: reference({ kind: "children_outcomes", key: "briefs", schema: "results" }, []),
        predicate: { kind: "not", value: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" } }
      }
    },
    { key: "prior_failures", value: literal("results", []) }
  ]) })
};

const briefs_success: DecisionTree = {
  kind: "if",
  id: "briefs_success",
  condition: {
    kind: "every",
    source: reference({ kind: "children_outcomes", key: "briefs", schema: "results" }, []),
    predicate: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" }
  },
  then: briefs_advance,
  otherwise: briefs_failure
};

const briefs_pending: DecisionTree = {
  kind: "wait",
  id: "briefs_pending",
  continuations: ["briefs_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "briefs_finished" }
};

const briefs_all_terminal: DecisionTree = {
  kind: "if",
  id: "briefs_all_terminal",
  condition: reference({ kind: "children_complete", key: "briefs", schema: "flag" }, []),
  then: briefs_success,
  otherwise: briefs_pending
};

const briefs_stale: DecisionTree = {
  kind: "wait",
  id: "briefs_stale",
  continuations: ["briefs_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "briefs_finished" }
};

export const briefs_parent_phase: DecisionTree = {
  kind: "match",
  id: "briefs_parent_phase",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "briefing", node: briefs_all_terminal }],
  otherwise: briefs_stale
};
