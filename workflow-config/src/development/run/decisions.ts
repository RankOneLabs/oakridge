import type { DecisionTree } from "../../source-contracts";
import { literal, record, reference, variant } from "../../primitives/expressions";
import { prepare_parent_phase, analysis_parent_phase, plan_parent_phase, briefs_parent_phase } from "./stage-completion";
import { implementation_parent_phase, integration_parent_phase } from "./implementation-completion";

const root_begin: DecisionTree = {
  kind: "apply",
  id: "root_begin",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_root", variant: "preparing", value: literal("unit", {}) }) },
    { kind: "activate_child", key: "prepare" }
  ],
  actions: [],
  outcome: null
};

const root_cancel: DecisionTree = {
  kind: "apply",
  id: "root_cancel",
  mutations: [
    { kind: "cancel_children", key: "prepare" },
    { kind: "cancel_children", key: "analysis" },
    { kind: "cancel_children", key: "plan" },
    { kind: "cancel_children", key: "briefs" },
    { kind: "cancel_children", key: "implementation" },
    { kind: "cancel_children", key: "integration" }
  ],
  actions: [],
  outcome: variant({ schema: "run_result", variant: "cancelled", value: literal("unit", {}) })
};

const root_abandon: DecisionTree = {
  kind: "apply",
  id: "root_abandon",
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

const root_wait: DecisionTree = {
  kind: "wait",
  id: "root_wait",
  continuations: ["begin"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "begin" }
};

export const root_dispatch: DecisionTree = {
  kind: "match",
  id: "root_dispatch",
  value: reference({ kind: "trigger" }, []),
  cases: [
    { variant: "begin", node: root_begin },
    { variant: "prepare_finished", node: prepare_parent_phase },
    { variant: "analysis_finished", node: analysis_parent_phase },
    { variant: "plan_finished", node: plan_parent_phase },
    { variant: "briefs_finished", node: briefs_parent_phase },
    { variant: "implementation_finished", node: implementation_parent_phase },
    { variant: "integration_finished", node: integration_parent_phase },
    { variant: "cancel", node: root_cancel },
    { variant: "abandon", node: root_abandon }
  ],
  otherwise: root_wait
};
