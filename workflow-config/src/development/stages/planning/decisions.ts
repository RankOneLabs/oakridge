import type { DecisionTree } from "../../../source-contracts";
import { literal, optional, record, reference, variant } from "../../../primitives/expressions";

const planning_begin: DecisionTree = {
  kind: "apply",
  id: "planning_begin",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_review", variant: "working", value: literal("unit", {}) }) }],
  actions: [{ worker: "author", action: "initial" }],
  outcome: null
};

const planning_review: DecisionTree = {
  kind: "apply",
  id: "planning_review",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_review", variant: "review", value: literal("unit", {}) }) }],
  actions: [],
  outcome: null
};

const planning_accepted: DecisionTree = {
  kind: "apply",
  id: "planning_accepted",
  mutations: [
    { kind: "export", key: "accepted", value: literal("flag", true) },
    {
      kind: "export",
      key: "body",
      value: record("plan_body", [
        { key: "summary", value: reference({ kind: "output", key: "plan" }, ["summary"]) },
        {
          key: "cohorts",
          value: {
            kind: "check_collection",
            source: reference({ kind: "output", key: "plan" }, ["cohorts"]),
            key_field: "id",
            dependencies_field: "depends_on"
          }
        },
        { key: "dependency_order", value: reference({ kind: "output", key: "plan" }, ["dependency_order"]) },
        { key: "scope", value: reference({ kind: "output", key: "plan" }, ["scope"]) },
        { key: "acceptance_criteria", value: reference({ kind: "output", key: "plan" }, ["acceptance_criteria"]) },
        { key: "risks", value: reference({ kind: "output", key: "plan" }, ["risks"]) }
      ])
    }
  ],
  actions: [],
  outcome: variant({ schema: "result", variant: "complete", value: literal("unit", {}) })
};

const planning_exact_denied: DecisionTree = { kind: "reject", id: "planning_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const planning_exact: DecisionTree = {
  kind: "if",
  id: "planning_exact",
  condition: {
    kind: "all",
    items: [
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["revision"]),
        right: reference({ kind: "output_revision", key: "plan", schema: "revision" }, [])
      },
      {
        kind: "every",
        source: reference({ kind: "output", key: "plan" }, ["cohorts"]),
        predicate: {
          kind: "contains",
          source: {
            kind: "map",
            source: reference({ kind: "input" }, ["repositories"]),
            schema: "optional_repository_keys",
            value: optional("optional_ident", reference({ kind: "item" }, ["key"]))
          },
          value: reference({ kind: "item" }, ["repository_key"])
        }
      }
    ]
  },
  then: planning_accepted,
  otherwise: planning_exact_denied
};

const planning_revise: DecisionTree = {
  kind: "apply",
  id: "planning_revise",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_review", variant: "working", value: literal("unit", {}) }) },
    { kind: "clear_output", key: "plan" }
  ],
  actions: [{ worker: "author", action: "revise" }],
  outcome: null
};

const planning_feedback_exact_denied: DecisionTree = {
  kind: "reject",
  id: "planning_feedback_exact_denied",
  error: "invalid_command",
  detail: "command does not apply to current exact evidence"
};

const planning_feedback_exact: DecisionTree = {
  kind: "if",
  id: "planning_feedback_exact",
  condition: {
    kind: "equals",
    left: reference({ kind: "trigger" }, ["revision"]),
    right: reference({ kind: "output_revision", key: "plan", schema: "revision" }, [])
  },
  then: planning_revise,
  otherwise: planning_feedback_exact_denied
};

const planning_retry: DecisionTree = { kind: "apply", id: "planning_retry", mutations: [], actions: [{ worker: "author", action: "retry" }], outcome: null };

const planning_cancel: DecisionTree = {
  kind: "apply",
  id: "planning_cancel",
  mutations: [{ kind: "revoke", worker: "author" }, { kind: "stop", worker: "author" }],
  actions: [],
  outcome: variant({ schema: "result", variant: "cancelled", value: literal("unit", {}) })
};

const planning_abandon: DecisionTree = {
  kind: "apply",
  id: "planning_abandon",
  mutations: [{ kind: "revoke", worker: "author" }, { kind: "stop", worker: "author" }],
  actions: [],
  outcome: variant({ schema: "result", variant: "failed", value: literal("unit", {}) })
};

const planning_wait: DecisionTree = {
  kind: "wait",
  id: "planning_wait",
  continuations: ["accept"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "accept" }
};

export const planning_dispatch: DecisionTree = {
  kind: "match",
  id: "planning_dispatch",
  value: reference({ kind: "trigger" }, []),
  cases: [
    { variant: "begin", node: planning_begin },
    { variant: "submitted", node: planning_review },
    { variant: "accept", node: planning_exact },
    { variant: "request_changes", node: planning_feedback_exact },
    { variant: "retry", node: planning_retry },
    { variant: "cancel", node: planning_cancel },
    { variant: "abandon", node: planning_abandon }
  ],
  otherwise: planning_wait
};
