import type { DecisionTree } from "../source-contracts";
import { literal, reference, variant } from "../primitives/expressions";

const independent_advance: DecisionTree = {
  kind: "apply",
  id: "independent_advance",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_root", variant: "integrating", value: literal("unit", {}) }) },
    { kind: "activate_child", key: "integration" }
  ],
  actions: [],
  outcome: null
};

const independent_pending: DecisionTree = {
  kind: "wait",
  id: "independent_pending",
  continuations: ["implementation_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "implementation_finished" }
};

const independent_all_terminal: DecisionTree = {
  kind: "if",
  id: "independent_all_terminal",
  condition: reference({ kind: "children_complete", key: "implementation", schema: "flag" }, []),
  then: independent_advance,
  otherwise: independent_pending
};

const independent_stale: DecisionTree = {
  kind: "wait",
  id: "independent_stale",
  continuations: ["implementation_finished"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "implementation_finished" }
};

export const independent_parent_phase: DecisionTree = {
  kind: "match",
  id: "independent_parent_phase",
  value: reference({ kind: "state" }, []),
  cases: [{ variant: "implementing", node: independent_all_terminal }],
  otherwise: independent_stale
};
