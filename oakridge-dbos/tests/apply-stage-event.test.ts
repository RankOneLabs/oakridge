import { expect, test } from "bun:test";

import { StageEventApplier } from "../src/storage/apply-stage-event";
import { StageMachineRegistry } from "../src/runtime/executor-registry";
import type { CohortId, RunTransitionId } from "../src/domain/primitives";
import type { CompiledMachine } from "../src/domain/stage-machine";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";
import type { PostgresRunRecordWriter } from "../src/storage/postgres-run-record";

const machine: CompiledMachine = {
  initial: "pending",
  stage_type: "delegated_session",
  states: {
    pending: { status: "pending", blocked_reason: null, next_actor: "core", session_role: null },
    done: { status: "complete", blocked_reason: null, next_actor: null, session_role: null },
  },
  transitions: [{ from: "pending", on: { event: "started" }, guard: null, to: "done", effects: [] }],
} as unknown as CompiledMachine;

for (const [name, dependencies] of [
  ["chain", { a: [], b: ["a"], c: ["b"] }],
  ["diamond", { a: [], b: ["a"], c: ["a"], d: ["b", "c"] }],
] as const) {
  test(`apply_in visits each sibling once in a ${name}`, async () => {
    const cohorts = Object.entries(dependencies).map(([key, depends_on]) => ({
      id: key as CohortId, run_id: "run", stage_instance_id: "stage", cohort_key: key,
      state: "pending", status: "pending", round: 1, depends_on, durable_version: "0", stage_data: {},
    }));
    const visits = new Map<string, number>();
    const tx = { query: async (statement: string, parameters: readonly unknown[] = []) => {
      if (statement.includes("FROM oakridge.cohort WHERE id=$1")) {
        const id = String(parameters[0]);
        visits.set(id, (visits.get(id) ?? 0) + 1);
        return cohorts.filter((cohort) => cohort.id === id);
      }
      if (/FROM oakridge\.cohort\s+WHERE stage_instance_id=\$1/.test(statement)) return cohorts;
      if (statement.includes("FROM oakridge.stage_instance")) return [{ status: "active", stage_contract: {
        machine, materialization: { kind: "fan_out", max_parallel: 4 }, outputs: [], inputs: [],
      } }];
      if (statement.includes("FROM oakridge.workflow_run")) return [{ status: "active" }];
      return [];
    } } as unknown as SqlExecutor;
    const writer = { commit_in: async (_tx: SqlExecutor, input: { readonly owner: { readonly id: CohortId };
      readonly cohort_state: string; readonly change: { readonly status: string } }) => {
      const cohort = cohorts.find((candidate) => candidate.id === input.owner.id);
      if (!cohort) throw new Error("missing test cohort");
      cohort.state = input.cohort_state;
      cohort.status = input.change.status;
      cohort.durable_version = String(Number(cohort.durable_version) + 1);
      return { ok: true, value: { transition_id: `transition-${cohort.id}` as RunTransitionId } };
    } } as unknown as PostgresRunRecordWriter;
    const applier = new StageEventApplier({ sql: tx as TransactionalSqlExecutor, writer,
      registry: new StageMachineRegistry(), registered_effects: new Map(),
      load_stage_inputs: async () => ({}), start_effects: async () => {}, now: () => "2026-10-01T00:00:00Z" });
    const result = await applier.apply_in(tx, "a" as CohortId, { kind: "started" });
    expect(result.ok).toBe(true);
    expect(cohorts.every((cohort) => cohort.status === "complete")).toBe(true);
    expect([...visits.values()]).toEqual(cohorts.map(() => 1));
  });
}
