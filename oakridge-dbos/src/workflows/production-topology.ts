import { DBOS } from "@dbos-inc/dbos-sdk";

import { materializeStage } from "../compiler/materialize-stage";
import { resolveBindingValue, resolveDelegatedExecution } from "../compiler/resolve-execution";
import { selectAncestorStages } from "../compiler/select-resume-stages";
import { appendIncrementalUnit, closeIncrementalMaterialization, emptyIncrementalMaterialization, isFanOutDriverInput, selectDriverArtifacts, selectReadyUnits, type IncrementalMaterialization } from "../compiler/materialize-units";
import { isAwaitingReplacementOf, isLiveExecution, isRevisionUndecided, isStageDrained, selectLaunchedUnits, selectReleasedUnits, selectRevisionDelivery, selectRunningUnitCount, type UnitRuntime } from "./unit-runtime";
import type { ArtifactRevision, ExecutionContractState } from "../domain/artifacts";
import { envelopeIdentity, withAvailableArtifact, withReplacedEnvelope, type StageOutputEvent } from "../domain/output-availability";
import type { CompiledStageContract, CompiledWorkflowDefinition, MaterializedExecutionUnit } from "../domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import type { ArtifactEnvelope, ExecutionRequest, ExternalExecutionReference } from "../domain/execution";
import type { ArtifactId, ExecutionId, JsonValue, StageCoordinatorWorkflowId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../domain/primitives";
import type { HandoffWorkflowState } from "../domain/wait";
import type { StageFailureOutcome, StageOutcome } from "../domain/workflow";
import { stageRerunStateKey, type StageRerunState } from "../domain/rerun";
import type { StageAdmissionState } from "../domain/runs";
import { PROVISION_REPOSITORY_REFS_STAGE_TYPE, parseBaseBranch, parseRunContextRepository, type RepositoryProvisioningDefinitionConfig, type ResolvedRepositoryProvisioningConfig } from "../domain/repository-refs";
import { readJsonPointer } from "../domain/json-pointer";
import { relayWorkflowId, stageCoordinatorWorkflowId, unitExecutionWorkflowId, unitRevisionExecutionWorkflowId } from "../domain/workflow-ids";
import { containAttempt } from "./cancellation";
import { artifactContractExecutionWorkflow, type ArtifactContractExecutionResult } from "./executor-topology";

export interface RunWorkflowInput {
  readonly run_id: WorkflowRunId;
  readonly workflow_definition_id: WorkflowDefinitionId;
  readonly workflow_definition_version: number;
  readonly context: JsonValue;
  readonly resume_from_stage?: string;
  readonly created_at?: string;
  readonly forked_from_root_workflow_id?: string | null;
}

export interface StageInputSet { readonly [input_name: string]: ArtifactEnvelope | readonly ArtifactEnvelope[] }
export interface StageWorkflowInput {
  readonly run_id: WorkflowRunId;
  readonly root_workflow_id: string;
  readonly stage_instance_id: StageInstanceId;
  readonly stage_key: string;
  readonly compiled_stage: CompiledStageContract;
  readonly inputs: StageInputSet;
  readonly open_incremental_inputs: readonly string[];
  readonly context: JsonValue;
}
export interface StageWorkflowResult { readonly stage_instance_id: StageInstanceId; readonly outcome: StageOutcome; readonly artifacts: readonly ArtifactRevision[]; readonly execution_workflow_ids: Readonly<Record<string, string>> }
export interface RunWorkflowResult { readonly run_id: WorkflowRunId; readonly outcome: StageOutcome; readonly stage_workflow_ids: Readonly<Record<string, string>> }

interface PlannedExecution { readonly unit: MaterializedExecutionUnit; readonly request: ExecutionRequest }
interface PlanStageStepInput { readonly stage: CompiledStageContract; readonly stage_instance_id: StageInstanceId; readonly inputs: StageInputSet; readonly context: JsonValue }
interface PlanUnitStepInput extends PlanStageStepInput { readonly unit: MaterializedExecutionUnit }
export interface RecordExecutionInput { readonly request: ExecutionRequest; readonly execution_workflow_id: string; readonly parameters: JsonValue }
export interface StartStageInput { readonly run_id: WorkflowRunId; readonly attempt_root_workflow_id: string; readonly stage_instance_id: StageInstanceId; readonly stage: CompiledStageContract; readonly coordinator_workflow_id: StageCoordinatorWorkflowId; readonly started_at: string }
export interface FinishStageInput { readonly stage_instance_id: StageInstanceId; readonly outcome: StageOutcome; readonly ended_at: string }
export interface FinishRunInput { readonly attempt_root_workflow_id: string; readonly outcome: StageOutcome; readonly ended_at: string }
export interface ReplaceExecutionProjectionInput { readonly execution_id: ExecutionId; readonly replacement_workflow_id: string }

export interface ProductionTopologyServices {
  ensure_run(input: RunWorkflowInput & { readonly root_workflow_id: string }): Promise<void>;
  load_compiled_definition(id: WorkflowDefinitionId, version: number): Promise<CompiledWorkflowDefinition>;
  load_prompt_template(path: string): Promise<string>;
  find_external_reference(execution_id: ExecutionId): Promise<ExternalExecutionReference | null>;
  start_stage(input: StartStageInput): Promise<void>;
  finish_stage(input: FinishStageInput): Promise<void>;
  finish_run(input: FinishRunInput): Promise<void>;
  record_execution(input: RecordExecutionInput): Promise<void>;
  replace_execution_projection(input: ReplaceExecutionProjectionInput): Promise<void>;
  load_resume_artifacts(run_id: WorkflowRunId, stage_keys: readonly string[]): Promise<readonly (ArtifactRevision & { readonly stage_key: string })[]>;
  /** Where a revised input's handoff stands — the record of whether its consumer ever acted on it. */
  find_revision_handoff_state(artifact_revision_id: ArtifactId): Promise<HandoffWorkflowState | null>;
}

let services: ProductionTopologyServices | null = null;
export const registerProductionTopologyServices = (value: ProductionTopologyServices): void => { services = value; };
const topologyServices = (): ProductionTopologyServices => {
  if (!services) throw new Error("production topology services are not registered");
  return services;
};

const loadCompiledDefinitionStep = DBOS.registerStep(async (input: RunWorkflowInput): Promise<CompiledWorkflowDefinition> => topologyServices().load_compiled_definition(input.workflow_definition_id, input.workflow_definition_version), { name: "oakridgeLoadCompiledDefinitionStep", retriesAllowed: true });
const ensureRunStep = DBOS.registerStep(async (input: RunWorkflowInput & { readonly root_workflow_id: string }): Promise<void> => topologyServices().ensure_run(input), { name: "oakridgeEnsureRunStep", retriesAllowed: true });
const startStageStep = DBOS.registerStep(async (input: StartStageInput): Promise<void> => topologyServices().start_stage(input), { name: "oakridgeStartStageInstanceStep", retriesAllowed: true });
const finishStageStep = DBOS.registerStep(async (input: FinishStageInput): Promise<void> => topologyServices().finish_stage(input), { name: "oakridgeFinishStageInstanceStep", retriesAllowed: true });
const finishRunStep = DBOS.registerStep(async (input: FinishRunInput): Promise<void> => topologyServices().finish_run(input), { name: "oakridgeFinishRunAttemptStep", retriesAllowed: true });
const recordExecutionStep = DBOS.registerStep(async (input: RecordExecutionInput): Promise<void> => topologyServices().record_execution(input), { name: "oakridgeRecordExecutionProjectionStep", retriesAllowed: true });
const replaceExecutionProjectionStep = DBOS.registerStep(async (input: ReplaceExecutionProjectionInput): Promise<void> => topologyServices().replace_execution_projection(input), { name: "oakridgeReplaceExecutionProjectionStep", retriesAllowed: true });
const revisionHandoffStateStep = DBOS.registerStep(async (input: { readonly artifact_revision_id: ArtifactId }): Promise<HandoffWorkflowState | null> => topologyServices().find_revision_handoff_state(input.artifact_revision_id), { name: "oakridgeRevisionHandoffStateStep", retriesAllowed: true });
const loadResumeArtifactsStep = DBOS.registerStep(async (input: { readonly run_id: WorkflowRunId; readonly stage_keys: readonly string[] }) => topologyServices().load_resume_artifacts(input.run_id, input.stage_keys), { name: "oakridgeLoadResumeArtifactsStep", retriesAllowed: true });

const envelopes = (inputs: StageInputSet): readonly ArtifactEnvelope[] => Object.values(inputs).flatMap((value) => Array.isArray(value) ? value : [value as ArtifactEnvelope]);

/**
 * The slice of a stage's inputs one unit reads.
 *
 * Only `unit_complete` inputs are per-unit: they arrive one artifact at a time
 * as their producer releases each unit, and each carries the unit id it belongs
 * to — so a build sees its own brief and an assessor its own build result. A
 * `producer_complete` input is the producing stage's whole output, and the unit
 * ids in it belong to a different population entirely: the provisioned refs are
 * keyed by repository while the units consuming them are cohorts, so filtering
 * one by the other empties it and the unit resolves nothing at all.
 */
export const selectInputsForUnit = (stage: CompiledStageContract, inputs: StageInputSet, unit: MaterializedExecutionUnit): StageInputSet => {
  if (stage.materialization.kind !== "fan_out") return inputs;
  const perUnit = new Set(stage.inputs.filter((input) => input.delivery === "unit_complete").map((input) => input.name));
  return Object.fromEntries(Object.entries(inputs).map(([name, value]) =>
    Array.isArray(value) && perUnit.has(name) ? [name, value.filter((artifact) => artifact.unit_id === unit.unit_id)] : [name, value]));
};
const expectedArtifacts = (stage: CompiledStageContract, unit: MaterializedExecutionUnit) => {
  if (stage.materialization.kind !== "artifact_collection") return stage.outputs.map((output) => ({ unit_id: unit.unit_id, output_name: output.name, artifact_type: output.artifact_type }));
  if (!Array.isArray(unit.parameters)) throw new Error("artifact collection parameters must be an array");
  const idPath = stage.materialization.id_path;
  return unit.parameters.flatMap((item) => {
    const id = readJsonPointer(item, idPath);
    if (typeof id !== "string" || id.length === 0) throw new Error(`artifact collection id at '${idPath}' must be a non-empty string`);
    return stage.outputs.map((output) => ({ unit_id: id as UnitId, output_name: output.name, artifact_type: output.artifact_type }));
  });
};
/** The request shape every executor's plan shares, whatever resolved its config. */
const executionRequestFor = (input: PlanStageStepInput, unit: MaterializedExecutionUnit, unitInputs: StageInputSet, resolvedConfig: JsonValue): ExecutionRequest => ({
  execution_id: `${input.stage_instance_id}:${unit.unit_id}` as ExecutionId,
  stage_instance_id: input.stage_instance_id,
  unit_id: unit.unit_id,
  executor_type: input.stage.executor.executor_type,
  resolved_config: resolvedConfig,
  inputs: envelopes(unitInputs),
  declared_outputs: input.stage.outputs.map((output) => ({ name: output.name, artifact_type: output.artifact_type, required: true })),
  expected_artifacts: expectedArtifacts(input.stage, unit),
});

/**
 * Provisioning units resolve entirely from what they were materialized over —
 * one repository each, straight out of the run context — so there is no prompt
 * to render and no workspace to inherit. The declared output travels with the
 * config because the executor emits against it, and definition validation has
 * already established that there is exactly one.
 */
const resolveProvisioningPlans = (input: PlanStageStepInput, units: readonly MaterializedExecutionUnit[]): readonly PlannedExecution[] => {
  const output = input.stage.outputs[0];
  if (!output || input.stage.outputs.length !== 1) throw new Error(`stage '${input.stage.stage_key}' must declare exactly one repository refs output`);
  // Resolved once, outside the loop: every unit guarantees the same branch, and
  // resolving it per unit is how they would come to differ.
  //
  // `resolveBindingValue`, not `resolveBinding`: the latter stringifies whatever
  // it finds, so a context carrying `base_branch: null` resolved to the string
  // "null" and this stage pushed a branch by that name. The launch gate cannot
  // catch it either — a present-but-null key satisfies the pointer that reads
  // it, deliberately, because `planner_effort` means the runtime's default. A
  // branch name has no such reading, so it is checked where it is used.
  const definition = input.stage.executor.definition_config as unknown as RepositoryProvisioningDefinitionConfig;
  const resolvedBaseBranch = resolveBindingValue(definition.base_branch, { inputs: input.inputs, context: input.context, item: null });
  if (!resolvedBaseBranch.ok) throw new Error(`${resolvedBaseBranch.error.operation}:${input.stage.stage_key}:${resolvedBaseBranch.error.detail}`);
  const baseBranch = parseBaseBranch(resolvedBaseBranch.value);
  if (!baseBranch.ok) throw new Error(`${baseBranch.error.operation}:${input.stage.stage_key}:${baseBranch.error.detail}`);
  return units.map((unit) => {
    const repository = parseRunContextRepository(unit.parameters);
    if (!repository.ok) throw new Error(`${repository.error.operation}:${input.stage.stage_key}:${unit.unit_id}:${repository.error.detail}`);
    const resolved: ResolvedRepositoryProvisioningConfig = { executor_type: PROVISION_REPOSITORY_REFS_STAGE_TYPE, output_name: output.name, repository: repository.value, base_branch: baseBranch.value };
    return { unit, request: executionRequestFor(input, unit, {}, resolved as unknown as JsonValue) };
  });
};

const resolveDelegatedPlans = async (input: PlanStageStepInput, units: readonly MaterializedExecutionUnit[]): Promise<readonly PlannedExecution[]> => {
  const environment = { inputs: input.inputs, context: input.context, item: null } as const;
  const definition = input.stage.executor.definition_config as DelegatedSessionDefinitionConfig;
  const template = await topologyServices().load_prompt_template(definition.prompt_template_path);
  const plans: PlannedExecution[] = [];
  for (const unit of units) {
    const unitInputs = selectInputsForUnit(input.stage, input.inputs, unit);
    const resolved = resolveDelegatedExecution({ definition, environment: { ...environment, inputs: unitInputs }, unit, stage_instance_id: input.stage_instance_id, prompt_template: template });
    if (!resolved.ok) throw new Error(`${resolved.error.operation}:${resolved.error.detail}`);
    let workspaceSource: ExecutionRequest["workspace_source"];
    const inheritFrom = definition.fan_out?.inherit_worktree_from;
    if (inheritFrom) {
      const inheritedInput = unitInputs[inheritFrom];
      const candidates = inheritedInput === undefined ? [] : Array.isArray(inheritedInput) ? inheritedInput : [inheritedInput as ArtifactEnvelope];
      const source = candidates.length === 1 ? candidates[0] : null;
      if (!source?.producer_execution_id) throw new Error(`workspace input '${inheritFrom}' for unit '${unit.unit_id}' has no unique producer execution`);
      const externalReference = await topologyServices().find_external_reference(source.producer_execution_id);
      if (!externalReference) throw new Error(`workspace source execution '${source.producer_execution_id}' has no external reference`);
      workspaceSource = { execution_id: source.producer_execution_id, external_reference: externalReference };
    }
    plans.push({ unit, request: { ...executionRequestFor(input, unit, unitInputs, resolved.value as unknown as JsonValue),
      ...(workspaceSource ? { workspace_source: workspaceSource } : {}) } });
  }
  return plans;
};

const resolveExecutionPlans = async (input: PlanStageStepInput, units: readonly MaterializedExecutionUnit[]): Promise<readonly PlannedExecution[]> => {
  if (input.stage.executor.executor_type === PROVISION_REPOSITORY_REFS_STAGE_TYPE) return resolveProvisioningPlans(input, units);
  if (input.stage.executor.executor_type !== "delegated_session") throw new Error(`production resolver for executor '${input.stage.executor.executor_type}' is not registered`);
  return resolveDelegatedPlans(input, units);
};
const toExecutionPlan = async (input: PlanStageStepInput): Promise<readonly PlannedExecution[]> => {
  const environment = { inputs: input.inputs, context: input.context, item: null } as const;
  const units = materializeStage(input.stage, environment);
  if (!units.ok) throw new Error(`${units.error.operation}:${units.error.stage_key}:${units.error.detail}`);
  return resolveExecutionPlans(input, units.value);
};
const planStageStep = DBOS.registerStep(toExecutionPlan, { name: "oakridgePlanStageExecutionsStep", retriesAllowed: true });
const planUnitStep = DBOS.registerStep(async (input: PlanUnitStepInput): Promise<PlannedExecution> => {
  const plans = await resolveExecutionPlans(input, [input.unit]);
  const plan = plans[0];
  if (!plan) throw new Error(`incremental unit '${input.unit.unit_id}' produced no execution plan`);
  return plan;
}, { name: "oakridgePlanIncrementalExecutionStep", retriesAllowed: true });

/**
 * Whether a finished execution failed its unit.
 *
 * A satisfied contract is not undone by the executor having been cancelled
 * afterwards. The execution fences its own executor the moment the contract is
 * satisfied, and that fence closes the agent session, which the terminal
 * observer then reports as `cancelled` — so this branch was a race with our own
 * cleanup. It only ever passed because the workflow usually returned in the
 * milliseconds before the observation landed; when the order flipped, a unit
 * that had produced everything it owed was reported cancelled.
 *
 * A `failed` observation is deliberately still honoured on a satisfied
 * contract. Cancellation is something the system does to a finished executor;
 * a non-zero exit is the executor saying something went wrong, and that
 * deserves an operator's eyes rather than being assumed benign.
 *
 * The executor's own failure is reported ahead of the missing outputs it
 * caused. Both are true when an executor dies before emitting, but only one of
 * them says anything: `required_output_missing` names the symptom, while the
 * observation names the reason — a repository that is not a git repository, a
 * runtime that exited non-zero — and that is what an operator needs to act on.
 */
export const terminalFailure = (unit: UnitId, contract: ExecutionContractState, result: ArtifactContractExecutionResult): StageOutcome | null => {
  if (result.terminal_observation?.kind === "failed") return { kind: "failed", code: result.terminal_observation.code, detail: result.terminal_observation.detail };
  if (contract.kind !== "satisfied") return { kind: "failed", code: "required_output_missing", detail: `unit '${unit}' is missing: ${contract.missing_outputs.join(", ")}` };
  return null;
};

export const selectStageAdmissionState = (
  stageInstanceId: StageInstanceId,
  units: readonly MaterializedExecutionUnit[],
  admitted: ReadonlySet<UnitId>,
  released: ReadonlySet<UnitId>,
  manualAdmission: boolean,
  status: StageAdmissionState["status"] = "waiting",
): StageAdmissionState => ({
  stage_instance_id: stageInstanceId,
  status,
  manual_admission: manualAdmission,
  units: units.map((unit) => {
    const blockedBy = unit.depends_on.filter((dependency) => !released.has(dependency));
    return { unit_id: unit.unit_id, parameters: unit.parameters, admitted: admitted.has(unit.unit_id), eligible: blockedBy.length === 0, blocked_by: blockedBy };
  }),
});

type StageCommandEffect = { readonly kind: "applied" } | { readonly kind: "unhandled" } | { readonly kind: "terminal"; readonly outcome: StageOutcome };

/**
 * Which unit has to look again now that one of its inputs has been revised.
 *
 * Matched on what a unit was actually launched holding, because that is the
 * question being asked. Matching on unit id instead only works while a stage's
 * `unit_id_path` points at the driver artifact's own `unit_id` — true of the
 * seeded flow and of nothing the compiler enforces, and a definition that
 * reads its unit id out of the artifact body would mint units under ids the
 * artifact does not carry. The revision would then be dropped in silence,
 * which is the stall this whole mechanism exists to end.
 *
 * The id match remains as a fallback for a unit minted before this input
 * arrived, whose launch snapshot cannot mention it.
 */
export const selectRevisionConsumer = (
  plans: readonly PlannedExecution[],
  artifact: ArtifactEnvelope,
): UnitId | null => {
  const holder = plans.find((plan) => plan.request.inputs.some((candidate) => envelopeIdentity(candidate) === envelopeIdentity(artifact)));
  if (holder) return holder.unit.unit_id;
  return plans.some((plan) => plan.unit.unit_id === artifact.unit_id) ? artifact.unit_id : null;
};

interface UnitRelayInput { readonly coordinator_workflow_id: string; readonly unit_id: UnitId; readonly execution_workflow_id: string }

/**
 * Turns one unit finishing into a message on its coordinator's inbox.
 *
 * The coordinator cannot await its executions directly: an await is not a
 * `recv`, so for as long as it holds one it reads nothing, and a stage that
 * reads nothing cannot admit a unit, accept the next incremental input, take a
 * rerun, or notice it has been abandoned. Relaying completion through the same
 * inbox as every command leaves the coordinator with exactly one thing to wait
 * on, and lets it keep the parallelism window topped up as units land.
 *
 * An execution workflow that threw has no result to relay, so the error travels
 * as a value; without it the relay would die here and the unit would wait
 * forever for a signal that could never come.
 */
const stageUnitRelayWorkflow = DBOS.registerWorkflow(async (input: UnitRelayInput): Promise<void> => {
  let error: string | null = null;
  try {
    await DBOS.retrieveWorkflow<ArtifactContractExecutionResult>(input.execution_workflow_id).getResult();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  await DBOS.send(input.coordinator_workflow_id, { kind: "unit_finished", unit_id: input.unit_id, execution_workflow_id: input.execution_workflow_id, error } satisfies StageSignal,
    "stage-command", `finished:${input.execution_workflow_id}`);
}, { name: "oakridgeProductionStageUnitRelayWorkflow" });

export const productionStageWorkflow = DBOS.registerWorkflow(async (input: StageWorkflowInput): Promise<StageWorkflowResult> => {
  const coordinatorId = DBOS.workflowID;
  if (!coordinatorId) throw new Error("stage coordinator requires a workflow ID");
  const plans: PlannedExecution[] = [];
  const accumulatedInputs: Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]> = { ...input.inputs };
  let incremental: IncrementalMaterialization;
  if (input.open_incremental_inputs.length > 0) {
    if (input.compiled_stage.materialization.kind !== "fan_out") throw new Error(`incremental stage '${input.stage_key}' must use fan-out materialization`);
    incremental = emptyIncrementalMaterialization();
    // Units come from the input the stage fans out over, and from nothing else.
    // A stage can consume several incremental inputs — dev-flow's assessor takes
    // both `build_result` (its driver) and `brief` — and minting from the
    // non-drivers too either spawns a phantom unit per artifact or collides on
    // `unit_id` and fails the stage before it launches anything.
    for (const artifact of selectDriverArtifacts<ArtifactEnvelope>(input.compiled_stage.materialization, input.inputs)) {
      const parameters = { unit_id: artifact.unit_id, artifact: artifact.body } as const;
      const appended = appendIncrementalUnit(incremental, parameters, { unit_id_path: input.compiled_stage.materialization.unit_id_path, depends_on_path: input.compiled_stage.materialization.depends_on_path });
      if (!appended.ok) throw new Error(`${appended.error.operation}:${appended.error.detail}`);
      incremental = appended.value;
      const unit = incremental.units[incremental.units.length - 1];
      if (!unit) throw new Error("initial incremental unit disappeared");
      plans.push(await planUnitStep({ stage: input.compiled_stage, stage_instance_id: input.stage_instance_id, inputs: accumulatedInputs, context: input.context, unit }));
    }
  } else {
    plans.push(...await planStageStep({ stage: input.compiled_stage, stage_instance_id: input.stage_instance_id, inputs: input.inputs, context: input.context }));
    incremental = { units: plans.map((plan) => plan.unit), is_closed: true };
  }
  const openIncrementalInputs = new Set(input.open_incremental_inputs);
  const runtime = new Map<UnitId, UnitRuntime>();
  const isManualAdmission = input.compiled_stage.materialization.kind === "fan_out" && input.compiled_stage.materialization.manual_admission;
  const admitted = new Set<UnitId>(isManualAdmission ? [] : plans.map((plan) => plan.unit.unit_id));
  const executionWorkflowIds: Record<string, string> = {};
  // Chain-keyed, not appended: a unit relaunched onto a revised input settles
  // twice, and its second artifact replaces the first in this record rather
  // than standing beside it as a second artifact in a slot that holds one.
  let artifacts: readonly ArtifactRevision[] = [];
  // Revisions handed to a unit's live execution, until that execution returns
  // and the coordinator can check whether it acted on them.
  const notifiedRevisions = new Map<UnitId, readonly ArtifactEnvelope[]>();
  const complete = async (outcome: StageOutcome): Promise<StageWorkflowResult> => {
    await DBOS.setEvent("stage-admission-state", selectStageAdmissionState(input.stage_instance_id, plans.map((plan) => plan.unit), admitted, selectReleasedUnits(runtime), isManualAdmission, "closed"));
    await DBOS.closeStream("stage-output");
    return { stage_instance_id: input.stage_instance_id, outcome, artifacts, execution_workflow_ids: executionWorkflowIds };
  };

  /** Adopt an execution as this unit's live attempt and start relaying its completion. */
  const watchExecution = async (unitId: UnitId, executionWorkflowId: string): Promise<void> => {
    await DBOS.startWorkflow(stageUnitRelayWorkflow, { workflowID: relayWorkflowId(executionWorkflowId) })(
      { coordinator_workflow_id: coordinatorId, unit_id: unitId, execution_workflow_id: executionWorkflowId });
    executionWorkflowIds[unitId] = executionWorkflowId;
    runtime.set(unitId, { kind: "running", execution_workflow_id: executionWorkflowId });
  };

  /**
   * Put a released unit back to work on an input that has since been revised.
   *
   * Its own output was derived from the revision's predecessor, so it is stale
   * — and for a handoff input, the producer is holding an open wait that only
   * this unit's next decision can close. Leaving the revision undelivered
   * parked the cohort with nothing able to advance it and no gate for an
   * operator to answer, because the inbox is built from open gates and a unit
   * that never reruns never opens one.
   *
   * Re-planned rather than forked: the plan is what carries the unit's inputs,
   * and a fork would replay the execution against the artifact it has just been
   * told is out of date.
   */
  const relaunchForRevision = async (unitId: UnitId, artifact: ArtifactEnvelope): Promise<void> => {
    notifiedRevisions.delete(unitId);
    const superseded = plans.find((candidate) => candidate.unit.unit_id === unitId);
    if (!superseded) throw new Error(`execution plan '${unitId}' disappeared before its revision`);
    const replanned = await planUnitStep({ stage: input.compiled_stage, stage_instance_id: input.stage_instance_id,
      inputs: accumulatedInputs, context: input.context, unit: superseded.unit });
    plans[plans.indexOf(superseded)] = replanned;
    const executionWorkflowId = unitRevisionExecutionWorkflowId(coordinatorId, unitId, artifact.artifact_id);
    // The projection is what the emit route and the operator surface read: it
    // must name the new attempt and carry the inputs that attempt was given,
    // with the previous attempt's session and terminal observation cleared.
    await recordExecutionStep({ request: replanned.request, execution_workflow_id: executionWorkflowId, parameters: superseded.unit.parameters });
    await replaceExecutionProjectionStep({ execution_id: replanned.request.execution_id, replacement_workflow_id: executionWorkflowId });
    await DBOS.startWorkflow(artifactContractExecutionWorkflow, { workflowID: executionWorkflowId })(
      { request: replanned.request, outputs: input.compiled_stage.outputs, coordinator_workflow_id: coordinatorId });
    await watchExecution(unitId, executionWorkflowId);
  };

  /** Park a failed unit where an operator can find it, and free its slot. */
  const parkForRerun = async (unitId: UnitId, executionWorkflowId: string, failure: StageOutcome): Promise<void> => {
    runtime.set(unitId, { kind: "awaiting_rerun", execution_workflow_id: executionWorkflowId });
    await DBOS.setEvent(stageRerunStateKey(unitId), { status: "waiting", stage_instance_id: input.stage_instance_id, unit_id: unitId,
      failed_execution_workflow_id: executionWorkflowId, code: failure.kind === "failed" ? failure.code : "cancelled",
      detail: failure.kind === "failed" ? failure.detail : failure.kind === "cancelled" ? failure.reason : null } satisfies StageRerunState);
  };

  const settleUnit = async (signal: UnitCompletionSignal): Promise<void> => {
    // A thrown execution workflow is a failure like any other. Parking it keeps
    // the operator's rerun path open rather than taking the coordinator — and
    // with it every sibling unit still running — down alongside it.
    if (signal.error !== null) return parkForRerun(signal.unit_id, signal.execution_workflow_id, { kind: "failed", code: "execution_workflow_error", detail: signal.error });
    const result = await DBOS.retrieveWorkflow<ArtifactContractExecutionResult>(signal.execution_workflow_id).getResult();
    const failure = terminalFailure(signal.unit_id, result.contract, result);
    if (failure) return parkForRerun(signal.unit_id, signal.execution_workflow_id, failure);
    if (result.contract.kind !== "satisfied") throw new Error("satisfied execution contract disappeared");
    // Acceptance only. What the run may consume was published by the execution
    // as each output became visible, which for a handoff is long before this.
    for (const artifact of result.contract.artifacts) artifacts = withAvailableArtifact(artifacts, artifact);
    runtime.set(signal.unit_id, { kind: "released" });
    // A revision sent to this execution while it was already returning was
    // never read, and nothing in its result says so. The wait table does: a
    // handoff still awaiting its downstream decision is one this unit owes.
    const notified = notifiedRevisions.get(signal.unit_id) ?? [];
    notifiedRevisions.delete(signal.unit_id);
    for (const revision of notified) {
      if (!isRevisionUndecided(await revisionHandoffStateStep({ artifact_revision_id: revision.artifact_id }))) continue;
      await relaunchForRevision(signal.unit_id, revision);
      return;
    }
  };

  const applyStageCommand = async (command: StageSignal): Promise<StageCommandEffect> => {
    if (command.kind === "unit_finished") {
      // A relay for an execution the unit has since moved past — replaced by a
      // rerun, or redelivered after release — must not settle it a second time.
      if (isLiveExecution(runtime, command.unit_id, command.execution_workflow_id)) await settleUnit(command);
      return { kind: "applied" };
    }
    if (command.kind === "unit_output_event") {
      await DBOS.writeStream("stage-output", command.event);
      return { kind: "applied" };
    }
    if (command.kind === "replace_execution") {
      if (!isAwaitingReplacementOf(runtime, command.unit_id, command.failed_execution_workflow_id)) return { kind: "applied" };
      const plan = plans.find((candidate) => candidate.unit.unit_id === command.unit_id);
      if (!plan) throw new Error(`execution plan '${command.unit_id}' disappeared during rerun`);
      await replaceExecutionProjectionStep({ execution_id: plan.request.execution_id, replacement_workflow_id: command.replacement_execution_workflow_id });
      await watchExecution(command.unit_id, command.replacement_execution_workflow_id);
      await DBOS.setEvent(stageRerunStateKey(command.unit_id), { status: "resumed", stage_instance_id: input.stage_instance_id, unit_id: command.unit_id,
        replacement_execution_workflow_id: command.replacement_execution_workflow_id } satisfies StageRerunState);
      return { kind: "applied" };
    }
    if (command.kind === "abandon_stage") return { kind: "terminal", outcome: { kind: "cancelled", reason: command.reason } };
    if (command.kind === "admit_unit") {
      const admission = selectStageAdmissionState(input.stage_instance_id, plans.map((plan) => plan.unit), admitted, selectReleasedUnits(runtime), isManualAdmission);
      const unit = admission.units.find((candidate) => candidate.unit_id === command.unit_id);
      if (admission.manual_admission && unit?.eligible) admitted.add(command.unit_id);
      return { kind: "applied" };
    }
    if (command.kind === "input_closed") {
      openIncrementalInputs.delete(command.input_name);
      if (openIncrementalInputs.size === 0 && input.compiled_stage.materialization.kind === "fan_out") {
        const closed = closeIncrementalMaterialization(incremental, { unit_id_path: input.compiled_stage.materialization.unit_id_path, depends_on_path: input.compiled_stage.materialization.depends_on_path });
        if (!closed.ok) return { kind: "terminal", outcome: { kind: "failed", code: "invalid_incremental_materialization", detail: closed.error.detail } };
        incremental = closed.value;
      }
      return { kind: "applied" };
    }
    if (command.kind !== "input_released") return { kind: "unhandled" };
    if (input.compiled_stage.materialization.kind !== "fan_out") return { kind: "terminal", outcome: { kind: "failed", code: "unexpected_incremental_input", detail: `stage '${input.stage_key}' is not fan-out` } };
    // Every incremental artifact accumulates — units read all of their stage's
    // inputs. A later revision of one already delivered replaces it in place
    // rather than accumulating beside it. Only the driver input goes on to mint
    // a unit.
    const existingInput = accumulatedInputs[command.input_name];
    const existingArtifacts = existingInput === undefined ? [] : Array.isArray(existingInput) ? existingInput : [existingInput as ArtifactEnvelope];
    const isRevision = existingArtifacts.some((candidate) => envelopeIdentity(candidate) === envelopeIdentity(command.artifact));
    accumulatedInputs[command.input_name] = withReplacedEnvelope(existingArtifacts, command.artifact);
    // A revision of something a unit already consumed is that unit's work
    // again. Without this the revision lands in the accumulated inputs and
    // nothing tells the unit it is there: the upstream agent revises, and the
    // downstream one waits forever to be asked to look.
    if (isRevision) {
      const delivery = selectRevisionDelivery(runtime, selectRevisionConsumer(plans, command.artifact));
      if (delivery.kind === "notify") {
        await DBOS.send(delivery.execution_workflow_id, { kind: "input_revised", input_name: command.input_name, artifact: command.artifact },
          "execution-event", `revised:${command.artifact.artifact_id}`);
        notifiedRevisions.set(delivery.unit_id, withReplacedEnvelope(notifiedRevisions.get(delivery.unit_id) ?? [], command.artifact));
      } else if (delivery.kind === "relaunch") {
        await relaunchForRevision(delivery.unit_id, command.artifact);
      }
      return { kind: "applied" };
    }
    if (!isFanOutDriverInput(input.compiled_stage.materialization, command.input_name)) return { kind: "applied" };
    const parameters = { unit_id: command.artifact.unit_id, artifact: command.artifact.body } as const;
    const appended = appendIncrementalUnit(incremental, parameters, { unit_id_path: input.compiled_stage.materialization.unit_id_path, depends_on_path: input.compiled_stage.materialization.depends_on_path });
    if (!appended.ok) return { kind: "terminal", outcome: { kind: "failed", code: "invalid_incremental_materialization", detail: appended.error.detail } };
    incremental = appended.value;
    const unit = incremental.units[incremental.units.length - 1];
    if (!unit) throw new Error("appended incremental unit disappeared");
    plans.push(await planUnitStep({ stage: input.compiled_stage, stage_instance_id: input.stage_instance_id, inputs: accumulatedInputs, context: input.context, unit }));
    if (!input.compiled_stage.materialization.manual_admission) admitted.add(unit.unit_id);
    return { kind: "applied" };
  };
  const maxParallel = input.compiled_stage.materialization.kind === "fan_out" ? input.compiled_stage.materialization.max_parallel : 1;
  // One durable loop: top the parallelism window up, publish what the operator
  // can see, then wait on exactly one inbox. Units are started as slots free
  // rather than in batches, so a slow unit no longer holds back the siblings
  // queued behind it, and the stage stays responsive to commands throughout.
  for (;;) {
    const units = plans.map((plan) => plan.unit);
    const ready = selectReadyUnits(units, { released: selectReleasedUnits(runtime), admitted, launched: selectLaunchedUnits(runtime),
      running_count: selectRunningUnitCount(runtime), max_parallel: maxParallel });
    for (const unit of ready) {
      const plan = plans.find((candidate) => candidate.unit.unit_id === unit.unit_id);
      if (!plan) throw new Error(`execution plan '${unit.unit_id}' disappeared`);
      const executionWorkflowId = unitExecutionWorkflowId(coordinatorId, unit.unit_id);
      await recordExecutionStep({ request: plan.request, execution_workflow_id: executionWorkflowId, parameters: unit.parameters });
      await DBOS.startWorkflow(artifactContractExecutionWorkflow, { workflowID: executionWorkflowId })({ request: plan.request, outputs: input.compiled_stage.outputs, coordinator_workflow_id: coordinatorId });
      await watchExecution(unit.unit_id, executionWorkflowId);
    }
    await DBOS.setEvent("stage-admission-state", selectStageAdmissionState(input.stage_instance_id, units, admitted, selectReleasedUnits(runtime), isManualAdmission));
    if (isStageDrained(runtime, plans.length, incremental.is_closed)) return complete({ kind: "succeeded" });
    const command = await DBOS.recv<StageSignal>("stage-command", { timeoutSeconds: 86_400 });
    if (!command) continue;
    const effect = await applyStageCommand(command);
    if (effect.kind === "terminal") return complete(effect.outcome);
  }
}, { name: "oakridgeProductionStageWorkflow" });

/**
 * The stage coordinators still running when a run ends early. A stage that has
 * reported its outcome — including the one whose failure ended the run — is
 * already finished and must keep the record it wrote; everything else started
 * is an orphan whose delegated sessions are still alive.
 */
export const selectOrphanedStageCoordinators = (stage_workflow_ids: Readonly<Record<string, string>>, finished: ReadonlySet<string>): readonly string[] =>
  Object.entries(stage_workflow_ids).filter(([stageKey]) => !finished.has(stageKey)).map(([, coordinatorId]) => coordinatorId);

/**
 * Why the siblings of a failed stage are being stopped, in one readable line.
 * Narrowed to the outcomes that can end a run, so a success can never be
 * described here as a cancellation.
 */
export const stageFailureReason = (stage_key: string, outcome: StageFailureOutcome): string =>
  outcome.kind === "failed"
    ? `stage '${stage_key}' failed: ${outcome.code}`
    : `stage '${stage_key}' was cancelled${outcome.reason ? `: ${outcome.reason}` : ""}`;

/**
 * What a stage tells the run, on each of the two axes it reports.
 *
 * `stage_output` is availability: what the run may now consume from this stage.
 * `stage_finished` is the stage's own lifecycle. They are deliberately separate
 * messages because they are separate facts — an output can be available for as
 * long as a downstream review takes before the unit that produced it is
 * accepted, and a run that reads one where it means the other deadlocks.
 */
type RootSignal =
  | { readonly kind: "stage_output"; readonly stage_key: string; readonly event: StageOutputEvent }
  | { readonly kind: "stage_finished"; readonly stage_key: string; readonly result: StageWorkflowResult };
/** What the run workflow and the operator surface may ask of a stage. */
export type StageCommand =
  | { readonly kind: "input_released"; readonly input_name: string; readonly artifact: ArtifactEnvelope }
  | { readonly kind: "input_closed"; readonly input_name: string }
  | { readonly kind: "admit_unit"; readonly unit_id: UnitId }
  | { readonly kind: "replace_execution"; readonly unit_id: UnitId; readonly failed_execution_workflow_id: string; readonly replacement_execution_workflow_id: string }
  | { readonly kind: "abandon_stage"; readonly reason: string | null };

/** Posted by a stage's own unit relays, never by an operator. */
export type UnitCompletionSignal = { readonly kind: "unit_finished"; readonly unit_id: UnitId; readonly execution_workflow_id: string; readonly error: string | null };

/**
 * An availability change posted by one of the stage's own executions.
 *
 * The coordinator does not decide when an output becomes visible — the
 * execution does, from the output contract — so this passes straight through
 * onto the stage's output stream. Routing it through the coordinator's inbox
 * rather than writing the stream directly keeps a single writer on the stream
 * and orders availability ahead of the unit completion that follows it.
 */
export type UnitOutputEventSignal = { readonly kind: "unit_output_event"; readonly event: StageOutputEvent };

/** Everything a stage coordinator dequeues from its single inbox. */
export type StageSignal = StageCommand | UnitCompletionSignal | UnitOutputEventSignal;

interface StageRelayInput { readonly root_workflow_id: string; readonly stage_key: string; readonly handle_workflow_id: string }
const stageRelayWorkflow = DBOS.registerWorkflow(async (input: StageRelayInput): Promise<StageWorkflowResult> => {
  for await (const event of DBOS.readStream<StageOutputEvent>(input.handle_workflow_id, "stage-output")) {
    await DBOS.send(input.root_workflow_id, { kind: "stage_output", stage_key: input.stage_key, event } satisfies RootSignal, "root-signal", `${input.handle_workflow_id}:${event.artifact.id}`);
  }
  const result = await DBOS.retrieveWorkflow<StageWorkflowResult>(input.handle_workflow_id).getResult();
  await DBOS.send(input.root_workflow_id, { kind: "stage_finished", stage_key: input.stage_key, result } satisfies RootSignal, "root-signal", `finished:${result.stage_instance_id}`);
  return result;
}, { name: "oakridgeProductionStageRelayWorkflow" });

const stageInputs = (stageKey: string, definition: CompiledWorkflowDefinition, outputs: ReadonlyMap<string, readonly ArtifactRevision[]>): StageInputSet => {
  const result: Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]> = {};
  const stage = definition.stages[stageKey];
  if (!stage) return result;
  for (const edge of definition.edges.filter((candidate) => candidate.consumer_stage === stageKey)) {
    const artifacts = outputs.get(`${edge.producer_stage}:${edge.producer_output}`) ?? [];
    const input = stage.inputs.find((candidate) => candidate.name === edge.consumer_input);
    const values = artifacts.map((artifact) => ({ artifact_id: artifact.id, artifact_type: artifact.artifact_type, output_name: artifact.output_name, unit_id: artifact.unit_id, body: artifact.body,
      producer_execution_id: artifact.execution_id, chain_id: artifact.chain_id }));
    const requiresCollection = edge.delivery === "unit_complete" || input?.collect === true || isFanOutDriverInput(stage.materialization, edge.consumer_input);
    if (requiresCollection) result[edge.consumer_input] = values;
    else if (values[0]) result[edge.consumer_input] = values[0];
  }
  return result;
};

const isStageReady = (stageKey: string, definition: CompiledWorkflowDefinition, finished: ReadonlySet<string>, outputs: ReadonlyMap<string, readonly ArtifactRevision[]>): boolean => {
  const stage = definition.stages[stageKey];
  if (!stage) return false;
  for (const input of stage.inputs.filter((candidate) => !candidate.optional)) {
    const edge = definition.edges.find((candidate) => candidate.consumer_stage === stageKey && candidate.consumer_input === input.name);
    if (!edge) return false;
    if (edge.delivery === "producer_complete" && !finished.has(edge.producer_stage)) return false;
    if (edge.delivery === "unit_complete" && !finished.has(edge.producer_stage) && (outputs.get(`${edge.producer_stage}:${edge.producer_output}`)?.length ?? 0) === 0) return false;
  }
  return true;
};

export const productionRunWorkflow = DBOS.registerWorkflow(async (input: RunWorkflowInput): Promise<RunWorkflowResult> => {
  const rootId = DBOS.workflowID;
  if (!rootId) throw new Error("root workflow requires a workflow ID");
  await ensureRunStep({ ...input, root_workflow_id: rootId });
  const definition = await loadCompiledDefinitionStep(input);
  let ancestors: readonly string[] = [];
  if (input.resume_from_stage) {
    const selected = selectAncestorStages(definition, input.resume_from_stage);
    // Recorded as a failed run rather than thrown: a run that dies here leaves
    // no outcome for the operator surface to read, so the resume looks stuck
    // rather than rejected.
    if (!selected.ok) {
      const outcome: StageOutcome = { kind: "failed", code: "invalid_resume_stage", detail: selected.error.detail };
      await finishRunStep({ attempt_root_workflow_id: rootId, outcome, ended_at: new Date(await DBOS.now()).toISOString() });
      return { run_id: input.run_id, outcome, stage_workflow_ids: {} };
    }
    ancestors = selected.value;
  }
  const started = new Set<string>(ancestors);
  const finished = new Set<string>(ancestors);
  const outputs = new Map<string, readonly ArtifactRevision[]>();
  if (ancestors.length > 0) {
    const inherited = await loadResumeArtifactsStep({ run_id: input.run_id, stage_keys: ancestors });
    for (const artifact of inherited) {
      const key = `${artifact.stage_key}:${artifact.output_name}`;
      outputs.set(key, [...(outputs.get(key) ?? []), artifact]);
    }
  }
  const stageWorkflowIds: Record<string, string> = {};
  let terminal: StageOutcome = { kind: "succeeded" };
  while (finished.size < Object.keys(definition.stages).length) {
    for (const stageKey of Object.keys(definition.stages).sort()) {
      if (started.has(stageKey) || !isStageReady(stageKey, definition, finished, outputs)) continue;
      const stage = definition.stages[stageKey];
      if (!stage) throw new Error(`compiled stage '${stageKey}' disappeared`);
      const stageInstanceId = await DBOS.randomUUID() as StageInstanceId;
      const coordinatorId = stageCoordinatorWorkflowId(rootId, stageKey);
      const openIncrementalInputs = definition.edges.filter((edge) => edge.consumer_stage === stageKey && edge.delivery === "unit_complete" && !finished.has(edge.producer_stage)).map((edge) => edge.consumer_input);
      await startStageStep({ run_id: input.run_id, attempt_root_workflow_id: rootId, stage_instance_id: stageInstanceId, stage, coordinator_workflow_id: coordinatorId, started_at: new Date(await DBOS.now()).toISOString() });
      const handle = await DBOS.startWorkflow(productionStageWorkflow, { workflowID: coordinatorId })({ run_id: input.run_id, root_workflow_id: rootId, stage_instance_id: stageInstanceId, stage_key: stageKey, compiled_stage: stage, inputs: stageInputs(stageKey, definition, outputs), open_incremental_inputs: openIncrementalInputs, context: input.context });
      await DBOS.startWorkflow(stageRelayWorkflow, { workflowID: relayWorkflowId(coordinatorId) })({ root_workflow_id: rootId, stage_key: stageKey, handle_workflow_id: handle.workflowID });
      stageWorkflowIds[stageKey] = coordinatorId;
      started.add(stageKey);
    }
    const signal = await DBOS.recv<RootSignal>("root-signal", { timeoutSeconds: 86_400 });
    if (!signal) continue;
    if (signal.kind === "stage_output") {
      const artifact = signal.event.artifact;
      const key = `${signal.stage_key}:${artifact.output_name}`;
      outputs.set(key, withAvailableArtifact(outputs.get(key) ?? [], artifact));
      for (const edge of definition.edges.filter((candidate) => candidate.producer_stage === signal.stage_key && candidate.producer_output === artifact.output_name && candidate.delivery === "unit_complete" && started.has(candidate.consumer_stage) && !finished.has(candidate.consumer_stage))) {
        const target = stageWorkflowIds[edge.consumer_stage];
        if (target) await DBOS.send(target, { kind: "input_released", input_name: edge.consumer_input, artifact: { artifact_id: artifact.id, artifact_type: artifact.artifact_type, output_name: artifact.output_name, unit_id: artifact.unit_id, body: artifact.body,
          producer_execution_id: artifact.execution_id, chain_id: artifact.chain_id } } satisfies StageCommand, "stage-command", `${artifact.id}:${edge.consumer_input}`);
      }
      continue;
    }
    // A signal this workflow does not recognise must not fall through to the
    // branch that retires a stage — an unknown kind would finish a stage that
    // is still running and take the rest of the run down with it.
    if (signal.kind !== "stage_finished") continue;
    finished.add(signal.stage_key);
    await finishStageStep({ stage_instance_id: signal.result.stage_instance_id, outcome: signal.result.outcome, ended_at: new Date(await DBOS.now()).toISOString() });
    if (signal.result.outcome.kind !== "succeeded") {
      terminal = signal.result.outcome;
      // Siblings still running have nothing left to deliver into. Containment
      // rather than an `abandon_stage` command, because only containment fences
      // the delegated sessions themselves — a coordinator told to abandon would
      // stop scheduling but leave its live agents running, and billing.
      const orphaned = selectOrphanedStageCoordinators(stageWorkflowIds, finished);
      if (orphaned.length > 0) {
        await containAttempt({ root_workflow_id: rootId, reason: stageFailureReason(signal.stage_key, terminal), requested_at: new Date(await DBOS.now()).toISOString() },
          async () => undefined);
        for (const coordinatorId of orphaned) await DBOS.cancelWorkflow(coordinatorId, { cancelChildren: true });
      }
      break;
    }
    for (const edge of definition.edges.filter((candidate) => candidate.producer_stage === signal.stage_key && candidate.delivery === "unit_complete" && started.has(candidate.consumer_stage) && !finished.has(candidate.consumer_stage))) {
      const target = stageWorkflowIds[edge.consumer_stage];
      if (target) await DBOS.send(target, { kind: "input_closed", input_name: edge.consumer_input } satisfies StageCommand, "stage-command", `closed:${signal.result.stage_instance_id}:${edge.consumer_input}`);
    }
  }
  // The outcome is returned as a value, so DBOS records this workflow as
  // SUCCESS whether the run succeeded or failed. Persisting it to the domain
  // gives projections a result axis to read alongside DBOS's liveness axis —
  // without it, a failed run is indistinguishable from a completed one.
  await finishRunStep({ attempt_root_workflow_id: rootId, outcome: terminal, ended_at: new Date(await DBOS.now()).toISOString() });
  return { run_id: input.run_id, outcome: terminal, stage_workflow_ids: stageWorkflowIds };
}, { name: "oakridgeProductionRunWorkflow" });
