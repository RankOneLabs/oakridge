import { expect, test } from "bun:test";
import { evaluateCohort, transition } from "../src/decision/stage-machine";
import type { ImplementationCohortDefinition, ImplementationCohortRecord, ArtifactRef } from "../src/domain/dev-flow-v15";
import type { CompiledMachine, GuardContext, StageEvent, Transition } from "../src/domain/stage-machine";
import { machineRegistry, reviewMachine } from "./support/machine-fixtures";

const started: StageEvent = { kind: "started" };
const registry = machineRegistry();
const context = (event: StageEvent): GuardContext => ({ event, stage_data: {}, round_outputs: [], stage_inputs: {}, registry });
const machine = (rows: readonly Transition[]): CompiledMachine => ({ ...reviewMachine(), stage_type: "delegated_session", transitions: rows });

test("an unlisted event pair refuses without a row", () => {
  expect(transition(machine([]), "pending" as never, started, context(started))).toMatchObject({ kind: "refused", code: "no_transition", row_index: null });
});

test("first matching row wins and preserves effects in declaration order", () => {
  const rows = reviewMachine().transitions;
  const first = rows[0]!;
  const effects = [{ name: "record_output", args: {} }, { name: "end_session", args: {} }];
  const second = { ...first, to: "done", effects } as unknown as Transition;
  expect(transition(machine([second, first]), "pending" as never, started, context(started))).toMatchObject({ kind: "applied", to: "done", row_index: 0, effects });
});

test("a negated guard skips the first row when the predicate holds", () => {
  const first = { ...reviewMachine().transitions[0]!, guard: { name: "allow", negate: true, args: {} } } as Transition;
  const result = transition(machine([first, reviewMachine().transitions[0]!]), "pending" as never, started, context(started));
  expect(result).toMatchObject({ kind: "applied", row_index: 1 });
});

test("a missing negated guard cannot authorize a transition", () => {
  const row = { ...reviewMachine().transitions[0]!, guard: { name: "missing", negate: true, args: {} } } as Transition;
  expect(transition(machine([row]), "pending" as never, started, context(started))).toMatchObject({ kind: "refused", code: "no_transition", row_index: null });
});

test("guards see the event being transitioned rather than a stale context event", () => {
  const event: StageEvent = { kind: "cancel", actor: "current" };
  const stale: StageEvent = { kind: "cancel", actor: "stale" };
  const guardedRegistry = machineRegistry();
  guardedRegistry.register_guard("delegated_session", "current_actor" as never, (guardContext) =>
    guardContext.event.kind === "cancel" && guardContext.event.actor === "current");
  const row = { ...reviewMachine().transitions.at(-1)!, guard: { name: "current_actor", negate: false, args: {} } } as Transition;
  expect(transition(machine([row]), "pending" as never, event, { ...context(stale), registry: guardedRegistry })).toMatchObject({ kind: "applied", row_index: 0 });
});

test("any_nonterminal matches pending but not complete", () => {
  const event: StageEvent = { kind: "cancel", actor: "operator" };
  const row = reviewMachine().transitions.at(-1)!;
  expect(transition(machine([row]), "pending" as never, event, context(event)).kind).toBe("applied");
  expect(transition(machine([row]), "done" as never, event, context(event))).toMatchObject({ kind: "refused", code: "no_transition" });
});

test("a refusal row returns its code", () => {
  const row = { from: "pending", on: { event: "started" }, guard: null, refuse: "not_ready" } as Transition;
  expect(transition(machine([row]), "pending" as never, started, context(started))).toMatchObject({ kind: "refused", code: "not_ready", row_index: 0 });
});

const ref = { id: "00000000-0000-4000-8000-000000000001", version: 1 } as ArtifactRef;
const evaluatorDefinition = async (): Promise<ImplementationCohortDefinition> =>
  (await Bun.file(new URL("../../workflow-config/definitions/dev_flow_v15.json", import.meta.url)).json()).stages.implementation.cohort;
const pendingCohort = (): ImplementationCohortRecord => ({
  id: "00000000-0000-4000-8000-000000000010" as never,
  key: "core" as never,
  version: 0,
  state: "pending",
  depends_on: [],
  inputs: { brief: ref, repository: {
    refs: { repository_key: "oakridge" as never, repository_path: "/repo", integration_branch: "epic/wf",
      base_branch: "epic/schema", base_head_sha: "abc" as never },
    worktree_path: "/repo/worktree", worktree_base_sha: "abc" as never,
    canonical_branch: "cohort/core", expected_pr_base: "epic/schema",
  } },
  build: { state: "pending", outputs: { build_result: null, pr_summary: null }, sessions: [],
    active_execution_id: null, work: null, response: null, interrupted: null },
  assessment: { state: "pending", outputs: { assessment: null }, sessions: [],
    active_execution_id: null, work: null, response: null, interrupted: null },
  accepted_build: null,
});

test("the committed implementation tree starts a pending cohort with resolved frozen inputs", async () => {
  const selected = evaluateCohort({ definition: await evaluatorDefinition(), snapshot: pendingCohort(),
    request: null, pr: null, available_artifacts: [ref] });
  expect(selected).toEqual({ ok: true, value: {
    kind: "apply", expected_version: 0,
    changes: [{ kind: "set_cohort_state", state: "working" }, { kind: "set_worker_state", worker: "build", state: "working" }],
    actions: [{ worker: "build", action: { action_point: "initial", input: {
      brief: ref, repository: pendingCohort().inputs.repository as never,
    } } }],
  } });
});

test("a request invalid for the current state is a typed decision error", async () => {
  const selected = evaluateCohort({ definition: await evaluatorDefinition(), snapshot: pendingCohort(),
    request: { kind: "retry_build" }, pr: null, available_artifacts: [ref] });
  expect(selected).toEqual({ ok: false, error: expect.objectContaining({
    kind: "invalid_request", operation: "evaluate_cohort", cohort_id: pendingCohort().id,
  }) });
});

test("an inconsistent accepted builder is rejected before walking the tree", async () => {
  const snapshot = { ...pendingCohort(), state: "working" as const,
    build: { ...pendingCohort().build, state: "accepted" as const } };
  const selected = evaluateCohort({ definition: await evaluatorDefinition(), snapshot,
    request: null, pr: null, available_artifacts: [ref] });
  expect(selected).toEqual({ ok: false, error: expect.objectContaining({ kind: "invalid_state" }) });
});
