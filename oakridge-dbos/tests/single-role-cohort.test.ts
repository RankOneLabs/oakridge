/**
 * A one-role review loop over more than one revision round.
 *
 * The driver remembered one consumed gate. A second round leaves two closed
 * `revise` gates, neither of which ever becomes `accepted`, so the single slot
 * alternated between them: every step found the *other* gate unconsumed,
 * launched an attempt, and committed — and `cohortMachineWorkflow` continues
 * without a `recv` whenever something committed, so the loop is tight and every
 * pass starts a real session. It also never parked again, so the operator could
 * not approve their way out of it.
 */
import { expect, test } from "bun:test";

import { createSingleRoleCohortDriver } from "../src/adapters/single-role-cohort";
import { compileWorkflowDefinition } from "../src/compiler/compile-workflow";
import type { CompiledStageContract } from "../src/domain/compiled-workflow";
import type { ArtifactId, CohortId, JsonValue, StageInstanceId, UnitId, WaitId, WorkflowRunId } from "../src/domain/primitives";
import type { ArtifactEnvelope } from "../src/domain/execution";
import type { CohortMachineState, DecidedCohortGate } from "../src/domain/run-record";
import { createPromptBundle } from "../src/runtime/prompt-template";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";
import type { CohortStepContext, CohortStepDecision } from "../src/workflows/run-record-topology";

const RUN_ID = "00000000-0000-4000-8300-000000000001" as WorkflowRunId;
const STAGE_ID = "00000000-0000-4000-8300-000000000002" as StageInstanceId;
const COHORT_ID = "00000000-0000-4000-8300-000000000003" as CohortId;

const specStage = async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const bundle = await createPromptBundle(loaded.value, { load: async (path) => `prompt for ${path}` });
  const contract = compiled.value.stages.spec_analyzer;
  if (!contract) throw new Error("dev_flow_v15 has no spec_analyzer stage");
  return { contract, bundle };
};

const driverFor = (bundle: Awaited<ReturnType<typeof createPromptBundle>>) => createSingleRoleCohortDriver({
  records: { load_work_order_capability_seed: async () => "seed-value-for-tests" },
  load_prompt_bundle: async () => bundle.matrix,
  stage_type: "delegated_session",
});

const waitId = (index: number): WaitId => `33333333-3333-4333-8333-00000000000${index}` as WaitId;
const artifactId = (index: number): ArtifactId => `44444444-4444-4444-8444-00000000000${index}` as ArtifactId;

const revisedGate = (index: number): DecidedCohortGate => ({
  wait_id: waitId(index), output_name: "spec_analysis", action: "request_revision",
  artifact_id: artifactId(index), accepted: false, decided_at: `2026-09-29T0${index}:00:00.000Z`,
});

const contextOf = (state: CohortMachineState, contract: CompiledStageContract): CohortStepContext =>
  ({ state, stage_contract: contract as unknown as JsonValue, run_context: {}, inputs: {} });

const committed = (state: CohortMachineState, decision: CohortStepDecision): CohortMachineState => ({
  ...state,
  status: decision.event.change.status, blocked_reason: decision.event.change.blocked_reason,
  next_actor: decision.event.change.next_actor, stage_data: decision.event.stage_data,
  durable_version: state.durable_version + 1,
  attempt_count: state.attempt_count + (decision.launch === null ? 0 : 1),
});

const initialState = (stage_data: JsonValue): CohortMachineState => ({
  run_id: RUN_ID, stage_instance_id: STAGE_ID, stage_key: "spec_analyzer", cohort_id: COHORT_ID, cohort_key: "0",
  status: "pending", blocked_reason: null, next_actor: "core", durable_version: 0, stage_data,
  attempt_count: 0, accepted_outputs: [], open_waits: [], decided_gates: [], latest_unfinished_attempt_id: null,
});

test("a one-role cohort reaches a fixpoint after two revision rounds instead of alternating between them", async () => {
  const { contract, bundle } = await specStage();
  const driver = driverFor(bundle);
  const cohorts = await driver.open_cohorts({ run_id: RUN_ID, stage_instance_id: STAGE_ID,
    stage_contract: contract as unknown as JsonValue, run_context: {}, inputs: {} });
  let state = initialState(cohorts[0]!.stage_data);

  const first = await driver.step(contextOf(state, contract));
  expect(first?.launch).not.toBeUndefined();
  state = committed(state, first!);

  // Round one: the operator sends the spec back.
  state = { ...state, decided_gates: [revisedGate(1)] };
  const secondLaunch = await driver.step(contextOf(state, contract));
  expect(secondLaunch?.launch).not.toBeNull();
  state = committed(state, secondLaunch!);
  expect(await driver.step(contextOf(state, contract))).toBeNull();

  // Round two: a second closed `revise` gate, which the first round's decision
  // must not be forgotten for.
  state = { ...state, decided_gates: [revisedGate(1), revisedGate(2)] };
  const thirdLaunch = await driver.step(contextOf(state, contract));
  expect(thirdLaunch?.launch).not.toBeNull();
  state = committed(state, thirdLaunch!);

  expect(await driver.step(contextOf(state, contract))).toBeNull();
  // And asking twice more still says nothing: a fixpoint, not an alternation.
  expect(await driver.step(contextOf(state, contract))).toBeNull();
  expect(state.attempt_count).toBe(3);
});

test("a cohort parks on its open gate rather than relaunching, so the operator can approve", async () => {
  const { contract, bundle } = await specStage();
  const driver = driverFor(bundle);
  const state: CohortMachineState = {
    ...initialState({ unit_id: "0", artifact: null, launched: 2, consumed_gate_wait_ids: [waitId(1)] }),
    status: "active", next_actor: "agent", attempt_count: 2,
    decided_gates: [revisedGate(1)],
    open_waits: [{ wait_id: waitId(9), kind: "gate", output_name: "spec_analysis", artifact_id: artifactId(9) }],
  };
  const decision = await driver.step(contextOf(state, contract));
  expect(decision?.launch ?? null).toBeNull();
  expect(decision?.event.change).toEqual(expect.objectContaining({ status: "blocked", blocked_reason: "gate", next_actor: "operator" }));
});

/** An in-flight cohort's stored state still parses once the field becomes a set. */
test("stage_data written under the single-slot key is still read as a consumed gate", async () => {
  const { contract, bundle } = await specStage();
  const driver = driverFor(bundle);
  const state: CohortMachineState = {
    ...initialState({ unit_id: "0", artifact: null, launched: 2, consumed_gate_wait_id: waitId(1) }),
    status: "active", next_actor: "agent", attempt_count: 2, decided_gates: [revisedGate(1)],
  };
  expect(await driver.step(contextOf(state, contract))).toBeNull();
});

test("one of seven accepted briefs does not complete brief_writer", async () => {
  const { contract, bundle } = await briefStage();
  const state = { ...initialState({ unit_id: "0", artifact: null, launched: 1, consumed_gate_wait_ids: [] }),
    status: "active" as const, accepted_outputs: [acceptedBrief("versioning")] };
  expect(await driverFor(bundle).step(briefContext(state, contract))).toBeNull();
});

test("all seven accepted briefs complete only after open waits close", async () => {
  const { contract, bundle } = await briefStage();
  const accepted = BRIEF_KEYS.map(acceptedBrief);
  const state = { ...initialState({ unit_id: "0", artifact: null, launched: 1, consumed_gate_wait_ids: [] }),
    status: "active" as const, accepted_outputs: accepted };
  const driver = driverFor(bundle);
  const held = await driver.step(briefContext({ ...state,
    open_waits: [{ wait_id: waitId(9), kind: "gate" as const, output_name: "brief", artifact_id: artifactId(9) }] }, contract));
  expect(held?.event.change.status).not.toBe("complete");
  expect((await driver.step(briefContext(state, contract)))?.event.change.status).toBe("complete");
});

const BRIEF_KEYS = ["versioning", "schema", "docs", "rollout", "api", "ui", "release"] as const;

const acceptedBrief = (key: string): ArtifactEnvelope => ({
  artifact_id: artifactId(BRIEF_KEYS.indexOf(key as typeof BRIEF_KEYS[number]) + 1),
  artifact_type: "dev.build_brief", output_name: "brief", unit_id: "0" as UnitId,
  collection_key: key, body: { cohort_id: key, repository_key: "oakridge", depends_on: [] },
});

const briefStage = async () => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const bundle = await createPromptBundle(loaded.value, { load: async (path) => `prompt for ${path}` });
  const contract = compiled.value.stages.brief_writer;
  if (!contract) throw new Error("dev_flow_v15 has no brief_writer stage");
  return { contract, bundle };
};

const briefContext = (state: CohortMachineState, contract: CompiledStageContract): CohortStepContext => ({
  state, stage_contract: contract as unknown as JsonValue, run_context: {},
  inputs: { plan: { artifact_id: artifactId(8), artifact_type: "dev.plan", output_name: "plan",
    unit_id: "0" as UnitId, body: { cohorts: BRIEF_KEYS.map((id) => ({ id })) } } },
});
