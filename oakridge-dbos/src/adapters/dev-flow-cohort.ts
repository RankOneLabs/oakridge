/**
 * The dev-flow stage type's cohort driver: how a delegated-session stage opens
 * its cohorts and how one cohort advances.
 *
 * This is the composition side of `dev-flow-build.ts`, which owns the pure
 * machine. Everything here is a *translation*: committed v15 rows into the
 * `BuildCohortEvent` vocabulary the machine already understands, and the
 * machine's answer into the cohort transition core commits. It holds no state
 * of its own — the cohort's `stage_data` is the state, so a replay after
 * recovery reaches the same decision from the same rows.
 */
import {
  applyBuildCohortEvent,
  committedSessionLaunch,
  createBuildCohortMachine,
  initialBuildCohortState,
  selectBuildGateEvent,
  type BuildCohortEvent,
  type BuildCohortMachine,
  type BuildCohortState,
  type BuildSessionRole,
} from "./dev-flow-build";
import type { CompiledStageContract } from "../domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import { selectArtifactGateDisposition, selectBuiltInGateDisposition } from "../domain/gates";
import type { AttemptId, JsonValue, RunTransitionId, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import { hasOwn, readOwn } from "../domain/records";
import type { CohortMachineState, DecidedCohortGate, OpenCohort } from "../domain/run-record";
import type { PromptBundleEntry } from "../domain/workflow";
import { attemptWorkflowId } from "../decision/ids";
import { cohortIdFor, resolveCohortRoster } from "./cohort-roster";
import type { DevFlowPullRequestRepository, RunRecordRepository } from "../storage/repositories";
import { resolveAttemptExecution } from "../runtime/resolve-work-order";
import type { CohortMachineDriver, CohortStepContext, CohortStepDecision } from "../workflows/run-record-topology";

/** `oakridge.cohort.stage_data` for a dev-flow cohort. */
interface DevFlowCohortStageData {
  /** The fan-out item's own key, as the operator projections read it. */
  readonly unit_id: string;
  /** The item the stage fanned out over. Projections read `artifact.repository_key`. */
  readonly artifact: JsonValue;
  /** The build machine's own state, nested so it cannot collide with the item. */
  readonly build_state: BuildCohortState;
}

const isObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contractOf = (value: JsonValue): CompiledStageContract => {
  if (!isObject(value)) throw new Error("stage contract is not an object");
  return value as unknown as CompiledStageContract;
};

const definitionConfigOf = (contract: CompiledStageContract): DelegatedSessionDefinitionConfig =>
  contract.executor.definition_config as DelegatedSessionDefinitionConfig;

/** Which declared outputs the build role must fill before its gate can open. */
const requiredBuildSet = (contract: CompiledStageContract): readonly string[] => {
  const declared = definitionConfigOf(contract).required_build_set;
  if (declared && declared.length > 0) return declared;
  // A stage that declares none owes every gated output it has. Falling back to
  // the empty set would make `isBuildReviewReady` vacuously true and open the
  // gate on nothing.
  const gated = contract.outputs.filter((output) => output.release.kind !== "immediate").map((output) => output.name);
  return gated.length > 0 ? gated : contract.outputs.map((output) => output.name);
};

const stageDataOf = (state: CohortMachineState, contract: CompiledStageContract): DevFlowCohortStageData => {
  const stored = state.stage_data;
  if (isObject(stored) && hasOwn(stored, "build_state") && isObject(stored.build_state)) {
    return { unit_id: typeof stored.unit_id === "string" ? stored.unit_id : state.cohort_key,
      artifact: readOwn(stored, "artifact") ?? null,
      build_state: stored.build_state as unknown as BuildCohortState };
  }
  return {
    unit_id: isObject(stored) && typeof stored.unit_id === "string" ? stored.unit_id : state.cohort_key,
    artifact: isObject(stored) ? readOwn(stored, "artifact") ?? null : null,
    build_state: initialBuildCohortState(requiredBuildSet(contract)),
  };
};

const encodeStageData = (data: DevFlowCohortStageData): JsonValue => ({
  unit_id: data.unit_id, artifact: data.artifact,
  build_state: data.build_state as unknown as JsonValue,
});

/**
 * The next fact this cohort owes the machine, read from committed rows only.
 *
 * Order matters and is deliberate: a decided gate is the operator's answer and
 * outranks anything an agent has since published, and a published artifact
 * outranks the stage's own start. Exactly one event per step keeps each
 * transition attributable to one fact.
 */
const nextEvent = (
  state: CohortMachineState,
  build: BuildCohortState,
  contract: CompiledStageContract,
): BuildCohortEvent | null => {
  const consumedGate = (gate: DecidedCohortGate): boolean => {
    // A release has been consumed once the phase has moved past the review it
    // decided; a revision request, once the builder is active again.
    const disposition = selectArtifactGateDisposition(
      contract.outputs.find((output) => output.name === gate.output_name)?.artifact_type ?? "",
      selectBuiltInGateDisposition(gate.action));
    if (disposition === "release") {
      return gate.output_name === "assessment" || build.phase !== "build_review";
    }
    return build.phase === "builder_active";
  };
  const pendingGate = state.decided_gates.find((gate) => !consumedGate(gate));
  if (pendingGate) {
    const gateName = build.phase === "assessment_review" ? "assessment_review" as const : "build_review" as const;
    const translated = selectBuildGateEvent(gateName,
      selectArtifactGateDisposition(
        contract.outputs.find((output) => output.name === pendingGate.output_name)?.artifact_type ?? "",
        selectBuiltInGateDisposition(pendingGate.action)));
    if (translated.ok) return translated.value;
  }

  const assessment = state.accepted_outputs.find((artifact) => artifact.artifact_type === "dev.assessment");
  if (assessment && build.assessment_artifact_id !== assessment.artifact_id) {
    return { kind: "assessment_artifact_recorded", artifact_id: assessment.artifact_id };
  }

  const owed = build.required_build_set.find((name) => !build.accepted_build_set.includes(name));
  const published = owed === undefined
    ? undefined
    : state.accepted_outputs.find((artifact) => artifact.output_name === owed);
  if (owed !== undefined && published) {
    return { kind: "build_artifact_recorded", revision: published.artifact_id, output_name: owed };
  }

  if (build.phase === "pending") return { kind: "stage_started" };
  return null;
};

export interface DevFlowCohortDriverDependencies {
  readonly records: Pick<RunRecordRepository, "load_work_order_capability_seed">;
  readonly pull_requests: Pick<DevFlowPullRequestRepository, "find_cohort_for_unit">;
  /**
   * The prompt cells this run was pinned to, by `bundle_pin.prompt_bundle_hash`.
   * Loaded per run rather than read from the definition, because the pin is what
   * makes a mid-run bundle change unable to alter a session's prompt.
   */
  load_prompt_bundle(run_id: WorkflowRunId): Promise<readonly PromptBundleEntry[]>;
  /** The stage type this driver is registered for — the delegated-session executor. */
  readonly stage_type: string;
}

/** The roster, with each cohort opened at the build machine's initial state. */
const openDevFlowCohorts = (
  stage_instance_id: StageInstanceId,
  contract: CompiledStageContract,
  run_context: JsonValue,
): readonly OpenCohort[] =>
  resolveCohortRoster(contract, run_context).map((entry) => ({
    id: cohortIdFor(stage_instance_id, entry.cohort_key),
    cohort_key: entry.cohort_key,
    stage_data: encodeStageData({ unit_id: entry.cohort_key, artifact: entry.item,
      build_state: initialBuildCohortState(requiredBuildSet(contract)) }),
  }));

export const createDevFlowCohortDriver = (dependencies: DevFlowCohortDriverDependencies): CohortMachineDriver => ({
  stage_type: dependencies.stage_type,

  open_cohorts: async (input) => openDevFlowCohorts(input.stage_instance_id,
    contractOf(input.stage_contract), input.run_context),

  step(context: CohortStepContext): Promise<CohortStepDecision | null> {
    const contract = contractOf(context.stage_contract);
    const stageData = stageDataOf(context.state, contract);
    const event = nextEvent(context.state, stageData.build_state, contract);
    return event === null ? Promise.resolve(null) : applyOne(context, event, dependencies);
  },

  apply_event(context: CohortStepContext, event: JsonValue): Promise<CohortStepDecision | null> {
    const decoded = decodeBuildCohortEvent(event);
    return decoded === null ? Promise.resolve(null) : applyOne(context, decoded, dependencies);
  },
});

/**
 * An externally-supplied fact, narrowed to the machine's vocabulary.
 *
 * Parsed rather than cast: these arrive from the pull-request reconciler and the
 * final-stage routes, and an unrecognised name must be ignored rather than
 * committed as a transition whose effect nothing can read.
 */
const decodeBuildCohortEvent = (value: JsonValue): BuildCohortEvent | null => {
  if (!isObject(value) || typeof value.kind !== "string") return null;
  if (value.kind === "pull_request_verified" && typeof value.revision === "string" && typeof value.pull_request_url === "string") {
    return { kind: "pull_request_verified", revision: value.revision, pull_request_url: value.pull_request_url };
  }
  if ((value.kind === "pull_request_merged" || value.kind === "pull_request_mismatch"
    || value.kind === "replacement_pull_request_required") && typeof value.pull_request_url === "string") {
    return { kind: value.kind, pull_request_url: value.pull_request_url };
  }
  if (value.kind === "builder_attempt_lost" || value.kind === "assessor_attempt_lost" || value.kind === "stage_started") {
    return { kind: value.kind };
  }
  if (value.kind === "assessment_outcome_observed" && typeof value.outcome === "string") {
    return { kind: "assessment_outcome_observed", outcome: value.outcome };
  }
  return null;
};

/**
 * Applies exactly one event and shapes the transition it implies.
 *
 * `recorded_only` still commits: the machine's state changed, and the cohort's
 * own durable version is what makes that change observable to the next reader —
 * a fact recorded without a phase move is still a fact.
 */
const applyOne = async (
  context: CohortStepContext,
  event: BuildCohortEvent,
  dependencies: DevFlowCohortDriverDependencies,
): Promise<CohortStepDecision> => {
  const contract = contractOf(context.stage_contract);
  const stageData = stageDataOf(context.state, contract);
  const machine = buildMachineFor(contract, await dependencies.load_prompt_bundle(context.state.run_id));
  const applied = applyBuildCohortEvent(machine, stageData.build_state, event);
  const nextStageData: DevFlowCohortStageData = { ...stageData, build_state: applied.state };
  const launch = applied.launch;
  return {
    event: {
      change: applied.projection,
      stage_data: encodeStageData(nextStageData),
      effect: applied.effect as unknown as CohortStepDecision["event"]["effect"],
      launch_reason: launchReasonFor(event),
      actor: "core",
    },
    launch: launch === null ? null : {
      attempt_number: context.state.attempt_count + 1,
      adapter_type: contract.executor.executor_type,
      resolve_request: async (attempt_id: AttemptId, launch_transition_id: RunTransitionId) => {
        const cohort = await dependencies.pull_requests.find_cohort_for_unit(
          context.state.stage_instance_id, context.state.cohort_key as UnitId);
        const resolved = await resolveAttemptExecution({
          run_id: context.state.run_id, stage: contract, stage_instance_id: context.state.stage_instance_id,
          unit: { unit_id: context.state.cohort_key as UnitId, parameters: nextStageData.artifact, depends_on: [] },
          inputs: context.inputs, accepted_cohort_outputs: context.state.accepted_outputs, context: context.run_context,
          outputs: contract.outputs.map((output) => ({ output_name: output.name, artifact_type: output.artifact_type,
            release: output.release, attention: output.attention ?? "none" })),
          identity: `attempt:${attempt_id}`,
          capability_seed: await dependencies.records.load_work_order_capability_seed(),
          session_launch: committedSessionLaunch(launch_transition_id, launch,
            stageData.build_state.verified_pull_request?.url ?? null),
          attempt_id: attempt_id as unknown as WorkOrderId,
          attempt_workflow_id: attemptWorkflowId(attempt_id),
          ...(cohort ? { build_cohort: cohort } : {}),
        });
        return resolved.request;
      },
    },
  };
};

const launchReasonFor = (event: BuildCohortEvent): CohortStepDecision["event"]["launch_reason"] => {
  if (event.kind === "stage_started") return "initial";
  if (event.kind === "build_review_approved" || event.kind === "build_review_revision_requested"
    || event.kind === "assessment_review_approved" || event.kind === "assessment_review_revision_requested") return "gate_decided";
  if (event.kind === "builder_attempt_lost" || event.kind === "assessor_attempt_lost") return "retry";
  return "artifact_accepted";
};

/**
 * The validated machine for one stage contract and one pinned bundle.
 *
 * `createBuildCohortMachine` checks the whole role x launch-reason prompt matrix
 * before a cohort can run, so a later transition selects an already pinned
 * prompt cell rather than consulting a mutable bundle while rendering a session.
 * Only the cells this stage declares are offered to it: a bundle carries every
 * stage's cells, and an unrecognised one is a validation failure by design.
 */
const buildMachineFor = (contract: CompiledStageContract, bundle: readonly PromptBundleEntry[]): BuildCohortMachine => {
  const declared = new Set(definitionConfigOf(contract).prompt_matrix
    .map((entry) => `${entry.session_role}:${entry.launch_reason}:${entry.template_path}`));
  const created = createBuildCohortMachine({
    required_build_set: requiredBuildSet(contract),
    prompts: bundle.filter((entry) => declared.has(`${entry.session_role}:${entry.launch_reason}:${entry.template_path}`)),
  });
  if (!created.ok) throw new Error(`stage '${contract.stage_key}' has an invalid cohort machine: ${created.error}`);
  return created.value;
};

/** The roles this driver can launch, for a composition that wants to check them. */
export const DEV_FLOW_COHORT_ROLES: readonly BuildSessionRole[] = ["build", "assessment"];
