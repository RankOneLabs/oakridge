/**
 * The build cohort's review phase, driven through the real dev-flow driver.
 *
 * The driver fed the machine's `build_artifact_recorded` from
 * `artifact_acceptance` — rows a gate writes only once it has *released* the
 * artifact. So the phase that represents "the operator is holding the gate" was
 * entered after the gate had already answered: a `request_revision` arrived at
 * `builder_active`, where `consumedGate` treats it as already acted on, and the
 * cohort parked in `active`/`agent` with nobody able to move it.
 *
 * Every assertion here is about committed facts a cohort reads back off its own
 * rows, so the walk threads each decision's `stage_data` into the next state the
 * way `record_cohort_event` does.
 */
import { expect, test } from "bun:test";

import { createDevFlowCohortDriver } from "../src/adapters/dev-flow-cohort";
import type { BuildCohortState, BuildCohortTransitionEffect } from "../src/adapters/dev-flow-build";
import { compileWorkflowDefinition } from "../src/compiler/compile-workflow";
import type { StageInputSet } from "../src/decision/commands";
import type { CompiledStageContract } from "../src/domain/compiled-workflow";
import type { ArtifactEnvelope } from "../src/domain/execution";
import type { ArtifactId, CohortId, JsonValue, StageInstanceId, UnitId, WaitId, WorkflowRunId } from "../src/domain/primitives";
import type { CohortMachineState } from "../src/domain/run-record";
import { createPromptBundle } from "../src/runtime/prompt-template";
import { loadDevFlowV15 } from "../src/seed/dev-flow-v15";
import type { CohortStepContext, CohortStepDecision } from "../src/workflows/run-record-topology";

const RUN_ID = "00000000-0000-4000-8200-000000000001" as WorkflowRunId;
const STAGE_ID = "00000000-0000-4000-8200-000000000002" as StageInstanceId;

const briefBody = (unit: string): JsonValue => ({
  cohort_id: unit, repository_key: "oakridge", title: unit, goal: "ship it", files_in_scope: [],
  next_action: "build", decisions_made: [], acceptance_criteria: ["works"], depends_on: [],
});

const briefEnvelope = (unit: string): ArtifactEnvelope => ({
  artifact_id: `brief-${unit}` as ArtifactId, artifact_type: "dev.build_brief", output_name: "brief",
  unit_id: unit as UnitId, body: briefBody(unit),
});

/** The build stage fans out over its `brief` input, so the roster needs the inputs. */
const BUILD_INPUTS: StageInputSet = {
  brief: [briefEnvelope("foundation"), briefEnvelope("web")],
  repository_refs: [{ artifact_id: "refs-1" as ArtifactId, artifact_type: "dev.repository_refs",
    output_name: "repository_refs", unit_id: "oakridge" as UnitId,
    body: { repository_key: "oakridge", repository_path: "/repo/oakridge", integration_branch: "main",
      base_branch: "epic/test", base_head_sha: "9a8b7c6" } }],
};

const buildStage = async (): Promise<{ readonly contract: CompiledStageContract; readonly bundle: Awaited<ReturnType<typeof createPromptBundle>> }> => {
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const compiled = compileWorkflowDefinition(loaded.value);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const bundle = await createPromptBundle(loaded.value, { load: async (path) => `prompt for ${path}` });
  const contract = compiled.value.stages.build;
  if (!contract) throw new Error("dev_flow_v15 has no build stage");
  return { contract, bundle };
};

const driverFor = (bundle: Awaited<ReturnType<typeof createPromptBundle>>) => createDevFlowCohortDriver({
  records: { load_work_order_capability_seed: async () => "seed-value-for-tests" },
  pull_requests: { find_cohort_for_unit: async () => null },
  load_prompt_bundle: async () => bundle.matrix,
  stage_type: "delegated_session",
});

const buildStateOf = (state: CohortMachineState): BuildCohortState =>
  (state.stage_data as unknown as { readonly build_state: BuildCohortState }).build_state;

const launchOf = (decision: CohortStepDecision): BuildCohortTransitionEffect["session_launch"] =>
  (decision.event.effect as unknown as BuildCohortTransitionEffect).session_launch;

/** What `record_cohort_event` makes of one decision, as the next reader sees it. */
const committed = (state: CohortMachineState, decision: CohortStepDecision): CohortMachineState => ({
  ...state,
  status: decision.event.change.status,
  blocked_reason: decision.event.change.blocked_reason,
  next_actor: decision.event.change.next_actor,
  stage_data: decision.event.stage_data,
  durable_version: state.durable_version + 1,
  attempt_count: state.attempt_count + (decision.launch === null ? 0 : 1),
});

const contextOf = (state: CohortMachineState, contract: CompiledStageContract): CohortStepContext => ({
  state, stage_contract: contract as unknown as JsonValue, run_context: {}, inputs: BUILD_INPUTS,
});

const openWait = (wait_id: string, output_name: string, artifact_id: string): CohortMachineState["open_waits"][number] =>
  ({ wait_id: wait_id as WaitId, kind: "gate", output_name, artifact_id: artifact_id as ArtifactId });

const BUILD_WAIT = "11111111-1111-4111-8111-000000000001";
const SUMMARY_WAIT = "11111111-1111-4111-8111-000000000002";
const BUILD_ARTIFACT = "aaaaaaaa-1111-4111-8111-000000000001";
const SUMMARY_ARTIFACT = "aaaaaaaa-1111-4111-8111-000000000002";

const decidedGate = (wait_id: string, output_name: string, artifact_id: string, action: string): CohortMachineState["decided_gates"][number] =>
  ({ wait_id: wait_id as WaitId, output_name, action, artifact_id: artifact_id as ArtifactId,
    accepted: action === "approve", decided_at: "2026-09-29T00:00:00.000Z" });

/**
 * A cohort that has published both required outputs and had its pull request
 * verified: parked at `build_review`, with a wait open per published artifact.
 */
const parkedAtBuildReview = async (): Promise<{ readonly state: CohortMachineState; readonly contract: CompiledStageContract;
  readonly driver: ReturnType<typeof driverFor> }> => {
  const { contract, bundle } = await buildStage();
  const driver = driverFor(bundle);
  const cohorts = await driver.open_cohorts({ run_id: RUN_ID, stage_instance_id: STAGE_ID,
    stage_contract: contract as unknown as JsonValue, run_context: {}, inputs: BUILD_INPUTS });
  let state: CohortMachineState = {
    run_id: RUN_ID, stage_instance_id: STAGE_ID, stage_key: "build",
    cohort_id: cohorts[1]!.id, cohort_key: "web", status: "pending", blocked_reason: null, next_actor: "core",
    durable_version: 0, stage_data: cohorts[1]!.stage_data, attempt_count: 0,
    accepted_outputs: [], open_waits: [], decided_gates: [], latest_unfinished_attempt_id: null,
  };
  state = committed(state, (await driver.step(contextOf(state, contract)))!);
  state = { ...state, open_waits: [
    openWait(BUILD_WAIT, "build_result", BUILD_ARTIFACT),
    openWait(SUMMARY_WAIT, "pr_summary", SUMMARY_ARTIFACT)] };
  for (let recorded = await driver.step(contextOf(state, contract)); recorded !== null;
    recorded = await driver.step(contextOf(state, contract))) {
    state = committed(state, recorded);
  }
  // The wire carries a forge head and nothing else; the driver stamps which
  // publication the verification is good for, from the rows it just committed.
  const verified = await driver.apply_event(contextOf(state, contract), { kind: "pull_request_verified",
    head_sha: "feedfacefeedfacefeedfacefeedfacefeedface", pull_request_url: "https://example.test/pull/7" });
  state = committed(state, verified!);
  expect(buildStateOf(state).phase).toBe("build_review");
  return { state, contract, driver };
};

/**
 * `build_review` names two outputs, and a wait is opened per published artifact,
 * so one review is two waits. Answering one of them used to translate the whole
 * review: approving `build_result` launched the assessor while `pr_summary` was
 * still parked, and the cohort then projected `active`/`agent`, so the gate the
 * operator was still holding vanished from the surface.
 */
test("a build review is not settled until every wait under its gate name has answered", async () => {
  const { state: parked, contract, driver } = await parkedAtBuildReview();

  const halfAnswered: CohortMachineState = { ...parked,
    open_waits: [openWait(SUMMARY_WAIT, "pr_summary", SUMMARY_ARTIFACT)],
    accepted_outputs: [{ artifact_id: BUILD_ARTIFACT as ArtifactId, artifact_type: "dev.build_result",
      output_name: "build_result", unit_id: "web" as UnitId, body: {} }],
    decided_gates: [decidedGate(BUILD_WAIT, "build_result", BUILD_ARTIFACT, "approve")] };
  expect(await driver.step(contextOf(halfAnswered, contract))).toBeNull();
  expect({ status: halfAnswered.status, blocked_reason: halfAnswered.blocked_reason, next_actor: halfAnswered.next_actor })
    .toEqual({ status: "blocked", blocked_reason: "gate", next_actor: "operator" });

  const bothApproved: CohortMachineState = { ...halfAnswered, open_waits: [],
    accepted_outputs: [...halfAnswered.accepted_outputs,
      { artifact_id: SUMMARY_ARTIFACT as ArtifactId, artifact_type: "dev.pr_summary",
        output_name: "pr_summary", unit_id: "web" as UnitId, body: {} }],
    decided_gates: [...halfAnswered.decided_gates, decidedGate(SUMMARY_WAIT, "pr_summary", SUMMARY_ARTIFACT, "approve")] };
  const released = await driver.step(contextOf(bothApproved, contract));
  expect(launchOf(released!)).toEqual(expect.objectContaining({ session_role: "assessment", launch_reason: "initial_assessment" }));
  const assessing = committed(bothApproved, released!);
  expect(buildStateOf(assessing).phase).toBe("assessor_active");
  // Both decisions were consumed by the one translation, so the assessor is not
  // launched a second time for the sibling's answer.
  expect(await driver.step(contextOf(assessing, contract))).toBeNull();
});

/**
 * A gate decision the driver cannot act on at the current phase must not be
 * translated again on the next pass. `build_review_revision_requested` has no
 * branch outside `build_review`, so the machine answers `recorded_only` — which
 * still commits, and `cohortMachineWorkflow` skips its `recv` after a commit. A
 * phase-derived notion of "already consumed" turned that into one
 * `record_cohort_event` write per pass, without end.
 */
test("a revision requested on the sibling wait is translated once and then leaves a fixpoint", async () => {
  const { state: parked, contract, driver } = await parkedAtBuildReview();

  let state: CohortMachineState = { ...parked, open_waits: [],
    accepted_outputs: [{ artifact_id: BUILD_ARTIFACT as ArtifactId, artifact_type: "dev.build_result",
      output_name: "build_result", unit_id: "web" as UnitId, body: {} }],
    decided_gates: [decidedGate(BUILD_WAIT, "build_result", BUILD_ARTIFACT, "approve"),
      decidedGate(SUMMARY_WAIT, "pr_summary", SUMMARY_ARTIFACT, "request_revision")] };

  // One rejection makes the whole review a rejection, whatever its sibling said.
  const revised = await driver.step(contextOf(state, contract));
  expect(launchOf(revised!)).toEqual(expect.objectContaining({ session_role: "build", launch_reason: "revision_after_build_review" }));
  state = committed(state, revised!);
  expect(buildStateOf(state).phase).toBe("builder_active");

  // It converges, and it converges without launching anything else. The approved
  // `build_result` is still this cohort's current revision, so the restarted
  // builder is owed it once under the new publication — that is a bounded number
  // of recorded facts, not a decision the driver keeps making.
  const passes: string[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const again = await driver.step(contextOf(state, contract));
    if (again === null) break;
    passes.push((again.event.effect as unknown as { readonly event: { readonly kind: string } }).event.kind);
    expect(again.launch).toBeNull();
    state = committed(state, again);
  }
  expect(passes).toEqual(["build_artifact_recorded"]);
  expect(await driver.step(contextOf(state, contract))).toBeNull();
});

/**
 * Two items resolving to one cohort key is a fan-out that silently shrinks:
 * `cohortIdFor` is a function of the key, so both items open the same cohort row.
 * The keys are agent-supplied — a collecting output's `Output-Collection-Key`
 * becomes the envelope's `unit_id`, which is what `unit_id_path` reads.
 */
test("a fan-out over items sharing one cohort key is refused rather than collapsed", async () => {
  const { contract, bundle } = await buildStage();
  const driver = driverFor(bundle);
  const open = driver.open_cohorts({ run_id: RUN_ID, stage_instance_id: STAGE_ID,
    stage_contract: contract as unknown as JsonValue, run_context: {},
    inputs: { ...BUILD_INPUTS, brief: [briefEnvelope("web"), briefEnvelope("web")] } });
  await expect(open).rejects.toThrow(/repeated cohort key: web/);
});

test("a build cohort enters its review on publication, presents the gate, and relaunches the builder on request_revision", async () => {
  const { contract, bundle } = await buildStage();
  const driver = driverFor(bundle);

  // The roster comes from the brief input, one cohort per brief — the fan-out
  // binding names an input, so a roster resolved against the run context alone
  // cannot open a single cohort.
  const cohorts = await driver.open_cohorts({ run_id: RUN_ID, stage_instance_id: STAGE_ID,
    stage_contract: contract as unknown as JsonValue, run_context: {}, inputs: BUILD_INPUTS });
  expect(cohorts.map((cohort) => cohort.cohort_key)).toEqual(["foundation", "web"]);

  let state: CohortMachineState = {
    run_id: RUN_ID, stage_instance_id: STAGE_ID, stage_key: "build",
    cohort_id: cohorts[1]!.id, cohort_key: "web", status: "pending", blocked_reason: null, next_actor: "core",
    durable_version: 0, stage_data: cohorts[1]!.stage_data, attempt_count: 0,
    accepted_outputs: [], open_waits: [], decided_gates: [], latest_unfinished_attempt_id: null,
  };

  const started = await driver.step(contextOf(state, contract));
  expect(started).not.toBeNull();
  expect(launchOf(started!)?.launch_reason).toBe("initial_build");
  state = committed(state, started!);
  expect(buildStateOf(state).phase).toBe("builder_active");

  // The builder published both required outputs. Each is gated, so each sits in
  // its own open wait — and nothing is accepted yet, which is the whole point.
  state = { ...state, open_waits: [
    openWait("11111111-1111-4111-8111-000000000001", "build_result", "aaaaaaaa-1111-4111-8111-000000000001"),
    openWait("11111111-1111-4111-8111-000000000002", "pr_summary", "aaaaaaaa-1111-4111-8111-000000000002"),
  ] };

  for (const expected of ["build_result", "pr_summary"]) {
    const recorded = await driver.step(contextOf(state, contract));
    expect(recorded).not.toBeNull();
    expect(buildStateOf(committed(state, recorded!)).accepted_build_set).toContain(expected);
    state = committed(state, recorded!);
  }
  // Both outputs recorded under one revision: the machine has nothing further to
  // record, so the step is a fixpoint rather than a loop over its own siblings.
  expect(await driver.step(contextOf(state, contract))).toBeNull();

  const revision = buildStateOf(state).accepted_revision;
  expect(revision).not.toBeNull();
  const verified = await driver.apply_event(contextOf(state, contract),
    { kind: "pull_request_verified", head_sha: "feedfacefeedfacefeedfacefeedfacefeedface", pull_request_url: "https://example.test/pull/7" });
  expect(verified).not.toBeNull();
  state = committed(state, verified!);
  expect(buildStateOf(state).phase).toBe("build_review");
  // The stamp is the publication the driver read, not anything the reporter said.
  expect(buildStateOf(state).verified_pull_request?.accepted_revision).toBe(revision);
  // While the operator holds the gate, the cohort says so.
  expect({ status: state.status, blocked_reason: state.blocked_reason, next_actor: state.next_actor })
    .toEqual({ status: "blocked", blocked_reason: "gate", next_actor: "operator" });

  // The operator sends it back. `request_revision` closes the wait without an
  // acceptance, so the slot is empty and the replacement publishes into it.
  state = { ...state, open_waits: [],
    decided_gates: [{ wait_id: "11111111-1111-4111-8111-000000000001" as WaitId, output_name: "build_result",
      action: "request_revision", artifact_id: "aaaaaaaa-1111-4111-8111-000000000001" as ArtifactId,
      accepted: false, decided_at: "2026-09-29T00:00:00.000Z" }] };
  const revised = await driver.step(contextOf(state, contract));
  expect(revised).not.toBeNull();
  expect(revised!.launch).not.toBeNull();
  expect(launchOf(revised!)).toEqual(expect.objectContaining({ session_role: "build", launch_reason: "revision_after_build_review" }));
  expect(revised!.event.change).toEqual(expect.objectContaining({ status: "active", next_actor: "agent" }));

  // Once the builder is active again the decision is consumed: the same closed
  // gate must not launch a second replacement.
  state = committed(state, revised!);
  expect(buildStateOf(state).phase).toBe("builder_active");
  expect(await driver.step(contextOf(state, contract))).toBeNull();
});

test("a published assessment moves the cohort into its assessment review", async () => {
  const { contract, bundle } = await buildStage();
  const driver = driverFor(bundle);
  const cohort_id = "22222222-2222-4222-8222-000000000001" as CohortId;
  const build_state: BuildCohortState = {
    phase: "assessor_active", required_build_set: ["build_result", "pr_summary"],
    accepted_revision: "revision-1", accepted_build_set: ["build_result", "pr_summary"],
    verified_pull_request: { url: "https://example.test/pull/7", head_sha: "head-1", accepted_revision: "revision-1" },
    assessment_artifact_id: null, is_pull_request_merged: false,
  };
  const state: CohortMachineState = {
    run_id: RUN_ID, stage_instance_id: STAGE_ID, stage_key: "build", cohort_id, cohort_key: "web",
    status: "active", blocked_reason: null, next_actor: "agent", durable_version: 4,
    stage_data: { unit_id: "web", artifact: briefBody("web"), build_state: build_state as unknown as JsonValue },
    attempt_count: 2, accepted_outputs: [], decided_gates: [], latest_unfinished_attempt_id: null,
    open_waits: [openWait("11111111-1111-4111-8111-000000000003", "assessment", "aaaaaaaa-1111-4111-8111-000000000003")],
  };
  const decision = await driver.step(contextOf(state, contract));
  expect(decision).not.toBeNull();
  expect(decision!.event.change).toEqual(expect.objectContaining({ status: "blocked", blocked_reason: "gate", next_actor: "operator" }));
  expect(buildStateOf(committed(state, decision!)).phase).toBe("assessment_review");
});

const HEAD_SHA = "feedfacefeedfacefeedfacefeedfacefeedface";

/** A cohort whose stage has started, with both required outputs parked in their gate waits. */
const publishedAndParked = async (): Promise<{ state: CohortMachineState; readonly contract: CompiledStageContract;
  readonly driver: ReturnType<typeof driverFor> }> => {
  const { contract, bundle } = await buildStage();
  const driver = driverFor(bundle);
  const cohorts = await driver.open_cohorts({ run_id: RUN_ID, stage_instance_id: STAGE_ID,
    stage_contract: contract as unknown as JsonValue, run_context: {}, inputs: BUILD_INPUTS });
  let state: CohortMachineState = {
    run_id: RUN_ID, stage_instance_id: STAGE_ID, stage_key: "build",
    cohort_id: cohorts[1]!.id, cohort_key: "web", status: "pending", blocked_reason: null, next_actor: "core",
    durable_version: 0, stage_data: cohorts[1]!.stage_data, attempt_count: 0,
    accepted_outputs: [], open_waits: [], decided_gates: [], latest_unfinished_attempt_id: null,
  };
  state = committed(state, (await driver.step(contextOf(state, contract)))!);
  state = { ...state, open_waits: [
    openWait(BUILD_WAIT, "build_result", BUILD_ARTIFACT),
    openWait(SUMMARY_WAIT, "pr_summary", SUMMARY_ARTIFACT)] };
  return { state, contract, driver };
};

const drainSteps = async (start: CohortMachineState, contract: CompiledStageContract,
  driver: ReturnType<typeof driverFor>): Promise<CohortMachineState> => {
  let state = start;
  for (let pass = 0; pass < 8; pass += 1) {
    const decision = await driver.step(contextOf(state, contract));
    if (decision === null) return state;
    state = committed(state, decision);
  }
  throw new Error("cohort step did not reach a fixpoint");
};

/**
 * The gate's readiness test used to compare a forge `pushed_head_sha` against
 * published artifact ids joined with `+`. Those never match, so a build cohort
 * reached `build_review` in a driver test that supplied the revision by hand and
 * never on the real path: the work was published, the pull request was verified,
 * and the cohort sat at `builder_active` with nothing left to do.
 *
 * Which of the two facts lands first is not ordered — a publication wake and a
 * verification callback race — so both orders have to converge on the gate.
 */
test("a verified pull request and a published build open the review in either order", async () => {
  for (const verifyFirst of [false, true]) {
    const { state: parked, contract, driver } = await publishedAndParked();
    const verify = (state: CohortMachineState) => driver.apply_event(contextOf(state, contract),
      { kind: "pull_request_verified", head_sha: HEAD_SHA, pull_request_url: "https://example.test/pull/7" });

    let state = parked;
    if (verifyFirst) {
      state = committed(state, (await verify(state))!);
      expect(buildStateOf(state).phase).toBe("builder_active");
      state = await drainSteps(state, contract, driver);
    } else {
      state = await drainSteps(state, contract, driver);
      expect(buildStateOf(state).phase).toBe("builder_active");
      state = committed(state, (await verify(state))!);
    }
    expect(buildStateOf(state).phase).toBe("build_review");
    expect({ status: state.status, blocked_reason: state.blocked_reason, next_actor: state.next_actor })
      .toEqual({ status: "blocked", blocked_reason: "gate", next_actor: "operator" });
    expect(buildStateOf(state).verified_pull_request?.head_sha).toBe(HEAD_SHA);
    expect(await driver.step(contextOf(state, contract))).toBeNull();
  }
});

/**
 * Staleness is a read off the stamp rather than a write that discards the
 * verification: the URL stays, because `revision_after_build_review` cites it,
 * and the gate re-opens once the new publication has been verified in its turn.
 */
test("a republished build makes its verification stale without losing the pull request", async () => {
  const { state: parked, contract, driver } = await publishedAndParked();
  let state = await drainSteps(parked, contract, driver);
  state = committed(state, (await driver.apply_event(contextOf(state, contract),
    { kind: "pull_request_verified", head_sha: HEAD_SHA, pull_request_url: "https://example.test/pull/7" }))!);
  expect(buildStateOf(state).phase).toBe("build_review");

  // The operator sends it back and the builder publishes a fresh pair.
  state = { ...state, open_waits: [], decided_gates: [
    decidedGate(BUILD_WAIT, "build_result", BUILD_ARTIFACT, "request_revision"),
    decidedGate(SUMMARY_WAIT, "pr_summary", SUMMARY_ARTIFACT, "request_revision")] };
  state = await drainSteps(state, contract, driver);
  expect(buildStateOf(state).phase).toBe("builder_active");
  state = { ...state, open_waits: [
    openWait("11111111-1111-4111-8111-000000000003", "build_result", "aaaaaaaa-1111-4111-8111-000000000003"),
    openWait("11111111-1111-4111-8111-000000000004", "pr_summary", "aaaaaaaa-1111-4111-8111-000000000004")] };
  state = await drainSteps(state, contract, driver);

  // Published again, and the old verification does not open the gate for it.
  expect(buildStateOf(state).phase).toBe("builder_active");
  expect(buildStateOf(state).verified_pull_request?.url).toBe("https://example.test/pull/7");
  expect(buildStateOf(state).verified_pull_request?.accepted_revision).not.toBe(buildStateOf(state).accepted_revision);

  const reverified = committed(state, (await driver.apply_event(contextOf(state, contract),
    { kind: "pull_request_verified", head_sha: "0ddba11", pull_request_url: "https://example.test/pull/7" }))!);
  expect(buildStateOf(reverified).phase).toBe("build_review");
  expect(buildStateOf(reverified).verified_pull_request?.accepted_revision).toBe(buildStateOf(reverified).accepted_revision);
});

/**
 * A freshness sweep must not rewind a cohort that has moved on. `awaiting_merge`
 * is blocked on the forge, and a re-verification there is news about the pull
 * request, not a reason to ask for the build review again.
 */
test("re-verifying a cohort past its build review records the head without rewinding the phase", async () => {
  const { state: parked, contract, driver } = await publishedAndParked();
  let state = await drainSteps(parked, contract, driver);
  state = committed(state, (await driver.apply_event(contextOf(state, contract),
    { kind: "pull_request_verified", head_sha: HEAD_SHA, pull_request_url: "https://example.test/pull/7" }))!);
  state = { ...state, open_waits: [], accepted_outputs: [
    { artifact_id: BUILD_ARTIFACT as ArtifactId, artifact_type: "dev.build_result", output_name: "build_result", unit_id: "web" as UnitId, body: {} },
    { artifact_id: SUMMARY_ARTIFACT as ArtifactId, artifact_type: "dev.pr_summary", output_name: "pr_summary", unit_id: "web" as UnitId, body: {} }],
  decided_gates: [
    decidedGate(BUILD_WAIT, "build_result", BUILD_ARTIFACT, "approve"),
    decidedGate(SUMMARY_WAIT, "pr_summary", SUMMARY_ARTIFACT, "approve")] };
  state = await drainSteps(state, contract, driver);
  expect(buildStateOf(state).phase).toBe("assessor_active");

  const refreshed = await driver.apply_event(contextOf(state, contract),
    { kind: "pull_request_verified", head_sha: "0ddba11", pull_request_url: "https://example.test/pull/7" });
  const after = committed(state, refreshed!);
  expect(buildStateOf(after).phase).toBe("assessor_active");
  expect(buildStateOf(after).verified_pull_request?.head_sha).toBe("0ddba11");
});
