import type { DecisionTree } from "../../../source-contracts";
import { literal, optional, reference, variant } from "../../../primitives/expressions";

const brief_begin: DecisionTree = {
  kind: "apply",
  id: "brief_begin",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_review", variant: "working", value: literal("unit", {}) }) }],
  actions: [{ worker: "author", action: "initial" }],
  outcome: null
};

const brief_review: DecisionTree = {
  kind: "apply",
  id: "brief_review",
  mutations: [{ kind: "set_state", value: variant({ schema: "phase_review", variant: "review", value: literal("unit", {}) }) }],
  actions: [],
  outcome: null
};

const brief_accepted: DecisionTree = {
  kind: "apply",
  id: "brief_accepted",
  mutations: [
    { kind: "export", key: "accepted", value: literal("flag", true) },
    {
      kind: "export",
      key: "briefs",
      value: {
        kind: "check_collection",
        source: reference({ kind: "output_collection", key: "briefs", schema: "brief_bodies" }, []),
        key_field: "cohort_id",
        dependencies_field: "depends_on"
      }
    }
  ],
  actions: [],
  outcome: variant({ schema: "result", variant: "complete", value: literal("unit", {}) })
};

const brief_membership_denied: DecisionTree = { kind: "reject", id: "brief_membership_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const brief_membership: DecisionTree = {
  kind: "if",
  id: "brief_membership",
  condition: {
    kind: "all",
    items: [
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["revisions"]),
        right: reference({ kind: "output_revisions", key: "briefs", schema: "revisions" }, [])
      },
      {
        kind: "equals",
        left: reference({ kind: "trigger" }, ["briefs"]),
        right: reference({ kind: "output_collection", key: "briefs", schema: "brief_bodies" }, [])
      },
      {
        kind: "all",
        items: [
          {
            kind: "every",
            source: reference({ kind: "output_collection", key: "briefs", schema: "brief_bodies" }, []),
            predicate: {
              kind: "contains",
              source: {
                kind: "map",
                source: reference({ kind: "input" }, ["plan", "cohorts"]),
                schema: "ids",
                value: reference({ kind: "item" }, ["id"])
              },
              value: reference({ kind: "item" }, ["cohort_id"])
            }
          },
          {
            kind: "every",
            source: reference({ kind: "input" }, ["plan", "cohorts"]),
            predicate: {
              kind: "contains",
              source: {
                kind: "map",
                source: reference({ kind: "output_collection", key: "briefs", schema: "brief_bodies" }, []),
                schema: "ids",
                value: reference({ kind: "item" }, ["cohort_id"])
              },
              value: reference({ kind: "item" }, ["id"])
            }
          },
          {
            kind: "every",
            source: reference({ kind: "output_collection", key: "briefs", schema: "brief_bodies" }, []),
            predicate: {
              kind: "all",
              items: [
                {
                  kind: "equals",
                  left: reference({ kind: "item" }, ["depends_on"]),
                  right: {
                    kind: "field",
                    value: {
                      kind: "lookup",
                      source: reference({ kind: "input" }, ["plan", "cohorts"]),
                      key_field: "id",
                      key: reference({ kind: "item" }, ["cohort_id"])
                    },
                    key: "depends_on"
                  }
                },
                {
                  kind: "equals",
                  left: optional("optional_ident", reference({ kind: "item" }, ["repository_key"])),
                  right: {
                    kind: "field",
                    value: {
                      kind: "lookup",
                      source: reference({ kind: "input" }, ["plan", "cohorts"]),
                      key_field: "id",
                      key: reference({ kind: "item" }, ["cohort_id"])
                    },
                    key: "repository_key"
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  },
  then: brief_accepted,
  otherwise: brief_membership_denied
};

const brief_plan_present_denied: DecisionTree = { kind: "reject", id: "brief_plan_present_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const brief_plan_present: DecisionTree = {
  kind: "match",
  id: "brief_plan_present",
  value: reference({ kind: "input" }, ["plan"]),
  cases: [{ variant: "some", node: brief_membership }],
  otherwise: brief_plan_present_denied
};

const brief_revise: DecisionTree = {
  kind: "apply",
  id: "brief_revise",
  mutations: [
    { kind: "set_state", value: variant({ schema: "phase_review", variant: "working", value: literal("unit", {}) }) },
    { kind: "clear_output", key: "briefs" }
  ],
  actions: [{ worker: "author", action: "revise" }],
  outcome: null
};

const brief_feedback_exact_denied: DecisionTree = { kind: "reject", id: "brief_feedback_exact_denied", error: "invalid_command", detail: "command does not apply to current exact evidence" };

const brief_feedback_exact: DecisionTree = {
  kind: "if",
  id: "brief_feedback_exact",
  condition: {
    kind: "equals",
    left: reference({ kind: "trigger" }, ["revisions"]),
    right: reference({ kind: "output_revisions", key: "briefs", schema: "revisions" }, [])
  },
  then: brief_revise,
  otherwise: brief_feedback_exact_denied
};

const brief_retry: DecisionTree = { kind: "apply", id: "brief_retry", mutations: [], actions: [{ worker: "author", action: "retry" }], outcome: null };

const brief_cancel: DecisionTree = {
  kind: "apply",
  id: "brief_cancel",
  mutations: [{ kind: "revoke", worker: "author" }, { kind: "stop", worker: "author" }],
  actions: [],
  outcome: variant({ schema: "result", variant: "cancelled", value: literal("unit", {}) })
};

const brief_abandon: DecisionTree = {
  kind: "apply",
  id: "brief_abandon",
  mutations: [{ kind: "revoke", worker: "author" }, { kind: "stop", worker: "author" }],
  actions: [],
  outcome: variant({ schema: "result", variant: "failed", value: literal("unit", {}) })
};

const brief_wait: DecisionTree = {
  kind: "wait",
  id: "brief_wait",
  continuations: ["accept"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "accept" }
};

export const brief_dispatch: DecisionTree = {
  kind: "match",
  id: "brief_dispatch",
  value: reference({ kind: "trigger" }, []),
  cases: [
    { variant: "begin", node: brief_begin },
    { variant: "submitted", node: brief_review },
    { variant: "accept", node: brief_plan_present },
    { variant: "request_changes", node: brief_feedback_exact },
    { variant: "retry", node: brief_retry },
    { variant: "cancel", node: brief_cancel },
    { variant: "abandon", node: brief_abandon },
    { variant: "session_failed", node: { ...brief_abandon, id: "brief_writing_session_failed" } },
  ],
  otherwise: brief_wait
};
