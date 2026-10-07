import type { DecisionTree } from "../../source-contracts";
import { literal, record, reference, variant } from "../../primitives/expressions";

const implementation_advance: DecisionTree = {
  kind: "apply",
  id: "implementation_advance",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_root", variant: "integrating", value: literal("unit", {}) }) },
    { kind: "activate_child", key: "integration" }
  ],
  actions: [],
  outcome: null
};

const implementation_pending: DecisionTree = {
  kind: "wait",
  id: "implementation_pending",
  continuations: ["implementation_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "implementation_finished" }
};

const implementation_all_terminal: DecisionTree = {
  kind: "if",
  id: "implementation_all_terminal",
  condition: reference({ kind: "children_complete", key: "implementation", schema: "flag" }, []),
  then: implementation_advance,
  otherwise: implementation_pending
};

const fail_fast_parent: DecisionTree = {
  kind: "apply",
  id: "fail_fast_parent",
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
        source: reference({ kind: "children_outcomes", key: "implementation", schema: "results" }, []),
        predicate: { kind: "not", value: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" } }
      }
    },
    { key: "prior_failures", value: literal("results", []) }
  ]) })
};

const implementation_success: DecisionTree = {
  kind: "if",
  id: "implementation_success",
  condition: {
    kind: "every",
    source: reference({ kind: "children_outcomes", key: "implementation", schema: "results" }, []),
    predicate: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" }
  },
  then: implementation_all_terminal,
  otherwise: fail_fast_parent
};

const implementation_stale: DecisionTree = {
  kind: "wait",
  id: "implementation_stale",
  continuations: ["implementation_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "implementation_finished" }
};

export const implementation_parent_phase: DecisionTree = {
  kind: "match",
  id: "implementation_parent_phase",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "implementing", node: implementation_success }],
  otherwise: implementation_stale
};

const root_complete: DecisionTree = {
  kind: "apply",
  id: "root_complete",
  mutations: [],
  actions: [],
  outcome: variant({ schema: "run_result", variant: "complete", value: literal("unit", {}) })
};

const root_aggregate_failures: DecisionTree = {
  kind: "apply",
  id: "root_aggregate_failures",
  mutations: [],
  actions: [],
  outcome: variant({ schema: "run_result", variant: "failed", value: record("failure_summary", [
    {
      key: "failures",
      value: {
        kind: "filter",
        source: reference({ kind: "children_outcomes", key: "implementation", schema: "results" }, []),
        predicate: { kind: "not", value: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" } }
      }
    },
    { key: "prior_failures", value: literal("results", []) }
  ]) })
};

const all_implementations_success: DecisionTree = {
  kind: "if",
  id: "all_implementations_success",
  condition: {
    kind: "every",
    source: reference({ kind: "children_outcomes", key: "implementation", schema: "results" }, []),
    predicate: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" }
  },
  then: root_complete,
  otherwise: root_aggregate_failures
};

const integration_failure: DecisionTree = {
  kind: "apply",
  id: "integration_failure",
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
        source: reference({ kind: "children_outcomes", key: "integration", schema: "results" }, []),
        predicate: { kind: "not", value: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" } }
      }
    },
    {
      key: "prior_failures",
      value: {
        kind: "filter",
        source: reference({ kind: "children_outcomes", key: "implementation", schema: "results" }, []),
        predicate: { kind: "not", value: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" } }
      }
    }
  ]) })
};

const integration_success: DecisionTree = {
  kind: "if",
  id: "integration_success",
  condition: {
    kind: "every",
    source: reference({ kind: "children_outcomes", key: "integration", schema: "results" }, []),
    predicate: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" }
  },
  then: all_implementations_success,
  otherwise: integration_failure
};

const integration_pending: DecisionTree = {
  kind: "wait",
  id: "integration_pending",
  continuations: ["integration_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "integration_finished" }
};

const integration_all_terminal: DecisionTree = {
  kind: "if",
  id: "integration_all_terminal",
  condition: reference({ kind: "children_complete", key: "integration", schema: "flag" }, []),
  then: integration_success,
  otherwise: integration_pending
};

const integration_stale: DecisionTree = {
  kind: "wait",
  id: "integration_stale",
  continuations: ["integration_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "integration_finished" }
};

export const integration_parent_phase: DecisionTree = {
  kind: "match",
  id: "integration_parent_phase",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "integrating", node: integration_all_terminal }],
  otherwise: integration_stale
};
