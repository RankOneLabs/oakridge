import type { ChildDefinition, DecisionTree, Expression, Mutation } from "../../source-contracts";
import { literal, optional, record, reference, variant } from "../../primitives/expressions";
import type { RunPolicy } from "../policies";

export interface StageRow {
  readonly key: string;
  readonly phase: string;
  readonly next_phase: string | null;
  readonly next_child: string | null;
  readonly completion: "standard" | "implementation" | "integration";
  readonly dependencies: readonly string[];
  readonly child: Omit<ChildDefinition, "depends_on">;
}
export type StageTable = readonly StageRow[];

/** Ordered stages are the source for child dependencies, completion routing and cancellation. */
export const STAGE_TABLE: StageTable = [
  { key: "prepare", phase: "preparing", next_phase: "analyzing", next_child: "analysis", completion: "standard", dependencies: [], child: {
      key: "prepare",
      scope: "repository_preparation",
      input: reference({ kind: "item" }, ["input"]),
      imports: ["references"],
      collection: {
        source: {
          kind: "map",
          source: reference({ kind: "input" }, ["repositories"]),
          schema: "prepare_members",
          value: record("prepare_member", [
            { key: "key", value: reference({ kind: "item" }, ["key"]) },
            { key: "input", value: reference({ kind: "item" }, ["preparation"]) },
            { key: "dependencies", value: literal("ids", []) }
          ])
        },
        key_field: "key",
        input_field: "input",
        dependencies_field: "dependencies",
        min_items: 1,
        max_items: 100,
        empty: { kind: "complete", outcome: variant({ schema: "run_result", variant: "complete", value: literal("unit", {}) }) }
      },
      on_terminal: "prepare_finished"
    } },
  { key: "analysis", phase: "analyzing", next_phase: "planning", next_child: "plan", completion: "standard", dependencies: ["prepare"], child: {
      key: "analysis",
      scope: "spec_analysis",
      input: record("task_input", [
        { key: "config", value: reference({ kind: "input" }, ["analysis"]) },
        { key: "spec", value: reference({ kind: "input" }, ["spec"]) },
        { key: "repositories", value: reference({ kind: "input" }, ["repositories"]) },
        {
          key: "repository_refs",
          value: reference({ kind: "children", key: "prepare", export: "references", schema: "repository_refs" }, [])
        },
        { key: "analysis", value: optional("optional_analysis", null) },
        { key: "plan", value: optional("optional_plan", null) }
      ]),
      imports: ["accepted", "body"],
      collection: null,
      on_terminal: "analysis_finished"
    } },
  { key: "plan", phase: "planning", next_phase: "briefing", next_child: "briefs", completion: "standard", dependencies: ["analysis", "prepare"], child: {
      key: "plan",
      scope: "planning",
      input: record("task_input", [
        { key: "config", value: reference({ kind: "input" }, ["planning"]) },
        { key: "spec", value: reference({ kind: "input" }, ["spec"]) },
        { key: "repositories", value: reference({ kind: "input" }, ["repositories"]) },
        {
          key: "repository_refs",
          value: reference({ kind: "children", key: "prepare", export: "references", schema: "repository_refs" }, [])
        },
        { key: "analysis", value: optional("optional_analysis", reference({ kind: "child", key: "analysis", export: "body" }, [])) },
        { key: "plan", value: optional("optional_plan", null) }
      ]),
      imports: ["accepted", "body"],
      collection: null,
      on_terminal: "plan_finished"
    } },
  { key: "briefs", phase: "briefing", next_phase: "implementing", next_child: "implementation", completion: "standard", dependencies: ["plan", "prepare"], child: {
      key: "briefs",
      scope: "brief_writing",
      input: record("task_input", [
        { key: "config", value: reference({ kind: "input" }, ["briefs"]) },
        { key: "spec", value: reference({ kind: "input" }, ["spec"]) },
        { key: "repositories", value: reference({ kind: "input" }, ["repositories"]) },
        {
          key: "repository_refs",
          value: reference({ kind: "children", key: "prepare", export: "references", schema: "repository_refs" }, [])
        },
        { key: "analysis", value: optional("optional_analysis", reference({ kind: "child", key: "analysis", export: "body" }, [])) },
        { key: "plan", value: optional("optional_plan", reference({ kind: "child", key: "plan", export: "body" }, [])) }
      ]),
      imports: ["accepted", "briefs"],
      collection: null,
      on_terminal: "briefs_finished"
    } },
  { key: "implementation", phase: "implementing", next_phase: "integrating", next_child: "integration", completion: "implementation", dependencies: ["briefs", "prepare"], child: {
      key: "implementation",
      scope: "implementation",
      input: reference({ kind: "item" }, ["input"]),
      imports: ["accepted", "integration", "completed_work"],
      collection: {
        source: {
          kind: "map",
          source: reference({ kind: "child", key: "briefs", export: "briefs" }, []),
          schema: "implementation_members",
          value: record("implementation_member", [
            { key: "key", value: reference({ kind: "item" }, ["cohort_id"]) },
            {
              key: "input",
              value: record("implementation_input", [
                { key: "brief", value: reference({ kind: "item" }, []) },
                {
                  key: "repository",
                  value: {
                    kind: "lookup",
                    source: reference({ kind: "input" }, ["repositories"]),
                    key_field: "key",
                    key: reference({ kind: "item" }, ["repository_key"])
                  }
                },
                {
                  key: "push_remote_owner",
                  value: {
                    kind: "field",
                    value: {
                      kind: "lookup",
                      source: reference({ kind: "children", key: "prepare", export: "references", schema: "repository_refs" }, []),
                      key_field: "repository_path",
                      key: {
                        kind: "field",
                        value: {
                          kind: "field",
                          value: {
                            kind: "lookup",
                            source: reference({ kind: "input" }, ["repositories"]),
                            key_field: "key",
                            key: reference({ kind: "item" }, ["repository_key"])
                          },
                          key: "preparation"
                        },
                        key: "repository_path"
                      }
                    },
                    key: "push_remote_owner"
                  }
                }
              ])
            },
            { key: "dependencies", value: reference({ kind: "item" }, ["depends_on"]) }
          ])
        },
        key_field: "key",
        input_field: "input",
        dependencies_field: "dependencies",
        min_items: 0,
        max_items: 100,
        empty: { kind: "complete", outcome: variant({ schema: "run_result", variant: "complete", value: literal("unit", {}) }) }
      },
      on_terminal: "implementation_finished",
      prerequisite_export: "accepted"
    } },
  { key: "integration", phase: "integrating", next_phase: null, next_child: null, completion: "integration", dependencies: ["implementation", "prepare"], child: {
      key: "integration",
      scope: "final_integration",
      input: reference({ kind: "item" }, ["input"]),
      imports: ["accepted"],
      collection: {
        source: {
          kind: "map",
          source: {
            kind: "unique_by",
            source: reference({ kind: "children", key: "implementation", export: "integration", schema: "integration_seeds" }, []),
            key_field: "repository_key"
          },
          schema: "integration_members",
          value: record("integration_member", [
            { key: "key", value: reference({ kind: "item" }, ["repository_key"]) },
            {
              key: "input",
              value: record("integration_input", [
                { key: "repository_key", value: reference({ kind: "item" }, ["repository_key"]) },
                { key: "config", value: reference({ kind: "item" }, ["config"]) },
                {
                  key: "completed_work",
                  value: {
                    kind: "filter_by",
                    source: reference({ kind: "children", key: "implementation", export: "completed_work", schema: "completed_works" }, []),
                    key_field: "repository_key",
                    key: reference({ kind: "item" }, ["repository_key"])
                  }
                },
                { key: "forge", value: reference({ kind: "item" }, ["forge"]) },
                { key: "push_remote_owner", value: reference({ kind: "item" }, ["push_remote_owner"]) }
              ])
            },
            { key: "dependencies", value: literal("ids", []) }
          ])
        },
        key_field: "key",
        input_field: "input",
        dependencies_field: "dependencies",
        min_items: 0,
        max_items: 100,
        empty: { kind: "complete", outcome: variant({ schema: "run_result", variant: "complete", value: literal("unit", {}) }) }
      },
      on_terminal: "integration_finished"
    } },
];

export function buildStageChildren(table: StageTable): ChildDefinition[] {
  return table.map(({ child, dependencies }) => {
    const { key, scope, input, imports, ...rest } = child;
    return { key, scope, input, depends_on: [...dependencies], imports, ...rest };
  });
}

export function cancelStageChildren(table: StageTable): Mutation[] {
  return table.map(({ key }) => ({ kind: "cancel_children", key }));
}

function failedOutcomes(key: string): Expression {
  return {
    kind: "filter",
    source: reference({ kind: "children_outcomes", key, schema: "results" }, []),
    predicate: { kind: "not", value: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" } }
  };
}

export function failureOutcome(key: string, priorKey: string | null = null): Expression {
  return variant({ schema: "run_result", variant: "failed", value: record("failure_summary", [
    { key: "failures", value: failedOutcomes(key) },
    { key: "prior_failures", value: priorKey === null ? literal("results", []) : failedOutcomes(priorKey) }
  ]) });
}

function allSuccessful(key: string): Expression {
  return {
    kind: "every",
    source: reference({ kind: "children_outcomes", key, schema: "results" }, []),
    predicate: { kind: "is_variant", value: reference({ kind: "item" }, []), variant: "complete" }
  };
}

export function advanceStage(row: StageRow, id = `${row.key}_advance`): DecisionTree {
  if (row.next_phase === null || row.next_child === null) throw new Error(`No successor for ${row.key}`);
  return {
    kind: "apply", id,
    mutations: [
      { kind: "set_state", value: variant({ schema: "phase_root", variant: row.next_phase, value: literal("unit", {}) }) },
      { kind: "activate_child", key: row.next_child }
    ], actions: [], outcome: null
  };
}

function waiting(row: StageRow, id: string): DecisionTree {
  const trigger = `${row.key}_finished`;
  return { kind: "wait", id, continuations: [trigger], reason: "awaiting declared work or operator review",
    attention: { label: "Awaiting work or review", trigger } };
}

function failure(table: StageTable, row: StageRow, id: string, priorKey: string | null = null): DecisionTree {
  return { kind: "apply", id, mutations: cancelStageChildren(table), actions: [], outcome: failureOutcome(row.key, priorKey) };
}

function standardGate(table: StageTable, row: StageRow): DecisionTree {
  const pending = waiting(row, `${row.key}_pending`);
  const success: DecisionTree = { kind: "if", id: `${row.key}_success`, condition: allSuccessful(row.key),
    then: advanceStage(row), otherwise: failure(table, row, `${row.key}_failure`) };
  const terminal: DecisionTree = { kind: "if", id: `${row.key}_all_terminal`,
    condition: reference({ kind: "children_complete", key: row.key, schema: "flag" }, []),
    then: success, otherwise: pending };
  return { kind: "match", id: `${row.key}_parent_phase`, value: reference({ kind: "state" }, []),
    cases: [{ variant: row.phase, node: terminal }], otherwise: waiting(row, `${row.key}_stale`) };
}

function implementationGate(table: StageTable, row: StageRow, policy: RunPolicy): DecisionTree {
  const independent = policy.sibling_failure === "continue_independent";
  const advance = advanceStage(row, independent ? "independent_advance" : "implementation_advance");
  const pending = waiting(row, independent ? "independent_pending" : "implementation_pending");
  const terminal: DecisionTree = { kind: "if", id: independent ? "independent_all_terminal" : "implementation_all_terminal",
    condition: reference({ kind: "children_complete", key: row.key, schema: "flag" }, []),
    then: advance, otherwise: pending };
  const selected: DecisionTree = independent ? terminal : {
    kind: "if", id: "implementation_success", condition: allSuccessful(row.key),
    then: terminal, otherwise: failure(table, row, "fail_fast_parent")
  };
  return { kind: "match", id: independent ? "independent_parent_phase" : "implementation_parent_phase",
    value: reference({ kind: "state" }, []), cases: [{ variant: row.phase, node: selected }],
    otherwise: waiting(row, independent ? "independent_stale" : "implementation_stale") };
}

function integrationGate(table: StageTable, row: StageRow): DecisionTree {
  const implementation = table.find((entry) => entry.completion === "implementation");
  if (!implementation) throw new Error("Integration requires an implementation stage");
  const complete: DecisionTree = { kind: "apply", id: "root_complete", mutations: [], actions: [],
    outcome: variant({ schema: "run_result", variant: "complete", value: literal("unit", {}) }) };
  const aggregate: DecisionTree = { kind: "apply", id: "root_aggregate_failures", mutations: [], actions: [],
    outcome: failureOutcome(implementation.key) };
  const allImplementations: DecisionTree = { kind: "if", id: "all_implementations_success",
    condition: allSuccessful(implementation.key), then: complete, otherwise: aggregate };
  const success: DecisionTree = { kind: "if", id: "integration_success", condition: allSuccessful(row.key),
    then: allImplementations, otherwise: failure(table, row, "integration_failure", implementation.key) };
  const terminal: DecisionTree = { kind: "if", id: "integration_all_terminal",
    condition: reference({ kind: "children_complete", key: row.key, schema: "flag" }, []),
    then: success, otherwise: waiting(row, "integration_pending") };
  return { kind: "match", id: "integration_parent_phase", value: reference({ kind: "state" }, []),
    cases: [{ variant: row.phase, node: terminal }], otherwise: waiting(row, "integration_stale") };
}

export function buildStageGate(table: StageTable, row: StageRow, policy: RunPolicy): DecisionTree {
  switch (row.completion) {
    case "standard": return standardGate(table, row);
    case "implementation": return implementationGate(table, row, policy);
    case "integration": return integrationGate(table, row);
  }
}
