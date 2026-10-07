import type { DecisionTree } from "../../source-contracts";
import { literal, reference, variant } from "../../primitives/expressions";
import type { RunPolicy } from "../policies";
import { STAGE_TABLE, type StageTable, buildStageGate, cancelStageChildren, failureOutcome } from "./stage-table";

export function buildRootDispatch(table: StageTable = STAGE_TABLE, policy: RunPolicy): DecisionTree {
  const first = table[0];
  const implementation = table.find((row) => row.completion === "implementation");
  if (!first || !implementation) throw new Error("A run needs an initial and implementation stage");
  const rootBegin: DecisionTree = {
    kind: "apply", id: "root_begin",
    mutations: [
      { kind: "set_state", value: variant({ schema: "phase_root", variant: first.phase, value: literal("unit", {}) }) },
      { kind: "activate_child", key: first.key }
    ], actions: [], outcome: null
  };
  const rootCancel: DecisionTree = {
    kind: "apply", id: "root_cancel", mutations: cancelStageChildren(table), actions: [],
    outcome: variant({ schema: "run_result", variant: "cancelled", value: literal("unit", {}) })
  };
  const rootAbandon: DecisionTree = {
    kind: "apply", id: "root_abandon", mutations: cancelStageChildren(table), actions: [],
    outcome: failureOutcome(implementation.key)
  };
  const rootWait: DecisionTree = {
    kind: "wait", id: "root_wait", continuations: ["begin"],
    reason: "awaiting declared work or operator review", attention: { label: "Awaiting work or review", trigger: "begin" }
  };
  return {
    kind: "match", id: "root_dispatch", value: reference({ kind: "trigger" }, []),
    cases: [
      { variant: "begin", node: rootBegin },
      ...(policy.stage_layout === "verification" ? [{ variant: "inspect", node: { kind: "apply" as const, id: "root_inspect", mutations: [], actions: [], outcome: null } }] : []),
      ...table.map((row) => ({ variant: `${row.key}_finished`, node: buildStageGate(table, row, policy) })),
      { variant: "cancel", node: rootCancel },
      { variant: "abandon", node: rootAbandon }
    ],
    otherwise: rootWait
  };
}
