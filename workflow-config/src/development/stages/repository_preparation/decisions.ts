import type { DecisionTree } from "../../../source-contracts";
import { literal, reference, variant } from "../../../primitives/expressions";

const prepare_begin: DecisionTree = {
  kind: "apply",
  id: "prepare_begin",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_simple", variant: "working", value: literal("unit", {}) }) }],
  actions: [{ worker: "preparation", action: "prepare" }],
  outcome: null
};

const prepare_retry: DecisionTree = { kind: "apply", id: "prepare_retry", mutations: [], actions: [{ worker: "preparation", action: "prepare" }], outcome: null };

const prepared: DecisionTree = {
  kind: "apply",
  id: "prepared",
  mutations: [{ kind: "export", key: "references", value: reference({ kind: "trigger" }, []) }],
  actions: [],
  outcome: variant({ schema: "result", variant: "complete", value: literal("unit", {}) })
};

const prepare_cancel: DecisionTree = {
  kind: "apply",
  id: "prepare_cancel",
  mutations: [{ kind: "revoke", worker: "preparation" }, { kind: "stop", worker: "preparation" }],
  actions: [],
  outcome: variant({ schema: "result", variant: "cancelled", value: literal("unit", {}) })
};

const prepare_abandon: DecisionTree = {
  kind: "apply",
  id: "prepare_abandon",
  mutations: [{ kind: "revoke", worker: "preparation" }, { kind: "stop", worker: "preparation" }],
  actions: [],
  outcome: variant({ schema: "result", variant: "failed", value: literal("unit", {}) })
};

const prepare_wait: DecisionTree = {
  kind: "wait",
  id: "prepare_wait",
  continuations: ["retry_preparation"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "retry_preparation" }
};

export const prepare_dispatch: DecisionTree = {
  kind: "match",
  id: "prepare_dispatch",
  value: reference({ kind: "trigger" }, []),
  cases: [
    { variant: "begin", node: prepare_begin },
    { variant: "retry_preparation", node: prepare_retry },
    { variant: "prepared", node: prepared },
    { variant: "provider_start_failed", node: { kind: "apply", id: "prepare_provider_start_failed",
      mutations: [{ kind: "set_state", value: variant({ schema: "phase_simple", variant: "working", value: literal("unit", {}) }) }],
      actions: [], outcome: null } },
    { variant: "cancel", node: prepare_cancel },
    { variant: "abandon", node: prepare_abandon }
  ],
  otherwise: prepare_wait
};
