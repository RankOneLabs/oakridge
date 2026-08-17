import { DBOS } from "@dbos-inc/dbos-sdk";

import { materializeStage } from "../compiler/materialize-stage";
import { resolveDelegatedExecution } from "../compiler/resolve-execution";
import { selectAncestorStages } from "../compiler/select-resume-stages";
import { appendIncrementalUnit, closeIncrementalMaterialization, emptyIncrementalMaterialization, isFanOutDriverInput, selectDriverArtifacts, selectReadyUnits, type IncrementalMaterialization } from "../compiler/materialize-units";
import { isAwaitingReplacementOf, isLiveExecution, isStageDrained, selectLaunchedUnits, selectReleasedUnits, selectRunningUnitCount, type UnitRuntime } from "./unit-runtime";
import type { ArtifactRevision, ExecutionContractState } from "../domain/artifacts";
import type { CompiledStageContract, CompiledWorkflowDefinition, MaterializedExecutionUnit } from "../domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import type { ArtifactEnvelope, ExecutionRequest, ExternalExecutionReference } from "../domain/execution";
import type { ExecutionId, JsonValue, StageCoordinatorWorkflowId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../domain/primitives";
import type { StageFailureOutcome, StageOutcome } from "../domain/workflow";
import { stageRerunStateKey, type StageRerunState } from "../domain/rerun";
import type { StageAdmissionState } from "../domain/runs";
import { readJsonPointer } from "../domain/json-pointer";
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
const loadResumeArtifactsStep = DBOS.registerStep(async (input: { readonly run_id: WorkflowRunId; readonly stage_keys: readonly string[] }) => topologyServices().load_resume_artifacts(input.run_id, input.stage_keys), { name: "oakridgeLoadResumeArtifactsStep", retriesAllowed: true });

const envelopes = (inputs: StageInputSet): readonly ArtifactEnvelope[] => Object.values(inputs).flatMap((value) => Array.isArray(value) ? value : [value as ArtifactEnvelope]);
export const selectInputsForUnit = (inputs: StageInputSet, unit: MaterializedExecutionUnit, isFanOut: boolean): StageInputSet => {
  if (!isFanOut) return inputs;
  return Object.fromEntries(Object.entries(inputs).map(([name, value]) => {
    if (!Array.isArray(value)) return [name, value];
    return [name, value.filter((artifact) => artifact.unit_id === unit.unit_id)];
  }));
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
const resolveExecutionPlans = async (input: PlanStageStepInput, units: readonly MaterializedExecutionUnit[]): Promise<readonly PlannedExecution[]> => {
  const environment = { inputs: input.inputs, context: input.context, item: null } as const;
  if (input.stage.executor.executor_type !== "delegated_session") throw new Error(`production resolver for executor '${input.stage.executor.executor_type}' is not registered`);
  const definition = input.stage.executor.definition_config as DelegatedSessionDefinitionConfig;
  const template = await topologyServices().load_prompt_template(definition.prompt_template_path);
  const plans: PlannedExecution[] = [];
  for (const unit of units) {
    const unitInputs = selectInputsForUnit(input.inputs, unit, input.stage.materialization.kind === "fan_out");
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
    plans.push({ unit, request: { execution_id: `${input.stage_instance_id}:${unit.unit_id}` as ExecutionId, stage_instance_id: input.stage_instance_id, unit_id: unit.unit_id,
      executor_type: input.stage.executor.executor_type, resolved_config: resolved.value as unknown as JsonValue, inputs: envelopes(unitInputs),
      declared_outputs: input.stage.outputs.map((output) => ({ name: output.name, artifact_type: output.artifact_type, required: true })), expected_artifacts: expectedArtifacts(input.stage, unit),
      ...(workspaceSource ? { workspace_source: workspaceSource } : {}) } });
  }
  return plans;
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

const terminalFailure = (unit: UnitId, contract: ExecutionContractState, result: ArtifactContractExecutionResult): StageOutcome | null => {
  if (contract.kind !== "satisfied") return { kind: "failed", code: "required_output_missing", detail: `unit '${unit}' is missing: ${contract.missing_outputs.join(", ")}` };
  if (result.terminal_observation?.kind === "failed") return { kind: "failed", code: result.terminal_observation.code, detail: result.terminal_observation.detail };
  if (result.terminal_observation?.kind === "cancelled") return { kind: "cancelled", reason: result.terminal_observation.detail };
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
  const artifacts: ArtifactRevision[] = [];
  const complete = async (outcome: StageOutcome): Promise<StageWorkflowResult> => {
    await DBOS.setEvent("stage-admission-state", selectStageAdmissionState(input.stage_instance_id, plans.map((plan) => plan.unit), admitted, selectReleasedUnits(runtime), isManualAdmission, "closed"));
    await DBOS.closeStream("stage-output");
    return { stage_instance_id: input.stage_instance_id, outcome, artifacts, execution_workflow_ids: executionWorkflowIds };
  };

  /** Adopt an execution as this unit's live attempt and start relaying its completion. */
  const watchExecution = async (unitId: UnitId, executionWorkflowId: string): Promise<void> => {
    await DBOS.startWorkflow(stageUnitRelayWorkflow, { workflowID: `${executionWorkflowId}:relay` })(
      { coordinator_workflow_id: coordinatorId, unit_id: unitId, execution_workflow_id: executionWorkflowId });
    executionWorkflowIds[unitId] = executionWorkflowId;
    runtime.set(unitId, { kind: "running", execution_workflow_id: executionWorkflowId });
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
    artifacts.push(...result.contract.artifacts);
    runtime.set(signal.unit_id, { kind: "released" });
    for (const artifact of result.contract.artifacts) await DBOS.writeStream("stage-output", artifact);
  };

  const applyStageCommand = async (command: StageSignal): Promise<StageCommandEffect> => {
    if (command.kind === "unit_finished") {
      // A relay for an execution the unit has since moved past — replaced by a
      // rerun, or redelivered after release — must not settle it a second time.
      if (isLiveExecution(runtime, command.unit_id, command.execution_workflow_id)) await settleUnit(command);
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
    // inputs. Only the driver input goes on to mint a unit.
    const existingInput = accumulatedInputs[command.input_name];
    const existingArtifacts = existingInput === undefined ? [] : Array.isArray(existingInput) ? existingInput : [existingInput as ArtifactEnvelope];
    accumulatedInputs[command.input_name] = [...existingArtifacts, command.artifact];
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
      const executionWorkflowId = `${coordinatorId}:unit:${unit.unit_id}`;
      await recordExecutionStep({ request: plan.request, execution_workflow_id: executionWorkflowId, parameters: unit.parameters });
      await DBOS.startWorkflow(artifactContractExecutionWorkflow, { workflowID: executionWorkflowId })({ request: plan.request, outputs: input.compiled_stage.outputs });
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

type RootSignal =
  | { readonly kind: "output_released"; readonly stage_key: string; readonly artifact: ArtifactRevision }
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

/** Everything a stage coordinator dequeues from its single inbox. */
export type StageSignal = StageCommand | UnitCompletionSignal;

interface StageRelayInput { readonly root_workflow_id: string; readonly stage_key: string; readonly handle_workflow_id: string }
const stageRelayWorkflow = DBOS.registerWorkflow(async (input: StageRelayInput): Promise<StageWorkflowResult> => {
  for await (const artifact of DBOS.readStream<ArtifactRevision>(input.handle_workflow_id, "stage-output")) {
    await DBOS.send(input.root_workflow_id, { kind: "output_released", stage_key: input.stage_key, artifact } satisfies RootSignal, "root-signal", `${input.handle_workflow_id}:${artifact.id}`);
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
      producer_execution_id: artifact.execution_id }));
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
      const coordinatorId = `${rootId}:stage:${stageKey}` as StageCoordinatorWorkflowId;
      const openIncrementalInputs = definition.edges.filter((edge) => edge.consumer_stage === stageKey && edge.delivery === "unit_complete" && !finished.has(edge.producer_stage)).map((edge) => edge.consumer_input);
      await startStageStep({ run_id: input.run_id, attempt_root_workflow_id: rootId, stage_instance_id: stageInstanceId, stage, coordinator_workflow_id: coordinatorId, started_at: new Date(await DBOS.now()).toISOString() });
      const handle = await DBOS.startWorkflow(productionStageWorkflow, { workflowID: coordinatorId })({ run_id: input.run_id, root_workflow_id: rootId, stage_instance_id: stageInstanceId, stage_key: stageKey, compiled_stage: stage, inputs: stageInputs(stageKey, definition, outputs), open_incremental_inputs: openIncrementalInputs, context: input.context });
      await DBOS.startWorkflow(stageRelayWorkflow, { workflowID: `${coordinatorId}:relay` })({ root_workflow_id: rootId, stage_key: stageKey, handle_workflow_id: handle.workflowID });
      stageWorkflowIds[stageKey] = coordinatorId;
      started.add(stageKey);
    }
    const signal = await DBOS.recv<RootSignal>("root-signal", { timeoutSeconds: 86_400 });
    if (!signal) continue;
    if (signal.kind === "output_released") {
      const key = `${signal.stage_key}:${signal.artifact.output_name}`;
      outputs.set(key, [...(outputs.get(key) ?? []), signal.artifact]);
      for (const edge of definition.edges.filter((candidate) => candidate.producer_stage === signal.stage_key && candidate.producer_output === signal.artifact.output_name && candidate.delivery === "unit_complete" && started.has(candidate.consumer_stage) && !finished.has(candidate.consumer_stage))) {
        const target = stageWorkflowIds[edge.consumer_stage];
        if (target) await DBOS.send(target, { kind: "input_released", input_name: edge.consumer_input, artifact: { artifact_id: signal.artifact.id, artifact_type: signal.artifact.artifact_type, output_name: signal.artifact.output_name, unit_id: signal.artifact.unit_id, body: signal.artifact.body,
          producer_execution_id: signal.artifact.execution_id } } satisfies StageCommand, "stage-command", `${signal.artifact.id}:${edge.consumer_input}`);
      }
      continue;
    }
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
