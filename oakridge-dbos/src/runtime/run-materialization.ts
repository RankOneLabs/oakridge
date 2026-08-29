import { createHash } from "node:crypto";

import { compileWorkflowDefinition } from "../compiler/compile-workflow";
import { materializeStage } from "../compiler/materialize-stage";
import { resolveBinding, resolveBindingValue, resolveDelegatedExecution } from "../compiler/resolve-execution";
import { readJsonPointer } from "../domain/json-pointer";
import type { CompiledStageContract, CompiledWorkflowDefinition, MaterializedExecutionUnit } from "../domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import type { ArtifactEnvelope, ExecutionRequest, ExternalExecutionReference } from "../domain/execution";
import { err, ok, type InputFingerprint, type JsonValue, type OutputCollectionKey, type Result, type RunUnitId, type StageInstanceId, type UnitId, type WorkflowRunId, type WorkOrderId } from "../domain/primitives";
import type { MaterializedRunOutput, MaterializedWorkOrder, PersistMaterializedStage, RunMaterializationRecord } from "../domain/run-record";
import { PROVISION_REPOSITORY_REFS_STAGE_TYPE, parseBaseBranch, parseRunContextRepository, type RepositoryProvisioningDefinitionConfig, type ResolvedRepositoryProvisioningConfig } from "../domain/repository-refs";
import type { RunRecordRepository, WorkflowDefinitionRepository } from "../storage/repositories";

const stableUuid = (identity: string): string => {
  const hex = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
};
const fingerprintOf = (value: unknown): InputFingerprint => createHash("sha256").update(JSON.stringify(value)).digest("hex") as InputFingerprint;
const capabilityFor = (seed: string, workOrderId: WorkOrderId): string => createHash("sha256").update(seed).update(":").update(workOrderId).digest("base64url");
const capabilityHash = (capability: string): string => createHash("sha256").update(capability).digest("hex");

const envelopes = (inputs: Readonly<Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]>>): readonly ArtifactEnvelope[] =>
  Object.values(inputs).flatMap((value) => Array.isArray(value) ? value : [value as ArtifactEnvelope]);

const stageInputs = (stageKey: string, definition: CompiledWorkflowDefinition, record: RunMaterializationRecord): Readonly<Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]>> => {
  const result: Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]> = {};
  const stage = definition.stages[stageKey];
  if (!stage) return result;
  for (const edge of definition.edges.filter((candidate) => candidate.consumer_stage === stageKey)) {
    const values = record.available_artifacts.filter((artifact) => artifact.producer_stage_key === edge.producer_stage && artifact.output_name === edge.producer_output);
    const input = stage.inputs.find((candidate) => candidate.name === edge.consumer_input);
    const driver = stage.materialization.kind !== "scalar" && stage.materialization.kind !== "artifact_collection"
      && stage.materialization.over.from === "input" && stage.materialization.over.input_name === edge.consumer_input;
    if (edge.delivery === "unit_complete" || input?.collect === true || driver) result[edge.consumer_input] = values;
    else if (values[0]) result[edge.consumer_input] = values[0];
  }
  return result;
};

const stageFinished = (record: RunMaterializationRecord, stageKey: string): boolean => {
  const stage = record.stages.find((candidate) => candidate.stage_key === stageKey);
  return Boolean(stage?.materialization_closed && stage.units.every((unit) => unit.state === "satisfied"));
};

const isReady = (stageKey: string, definition: CompiledWorkflowDefinition, record: RunMaterializationRecord): boolean => {
  const stage = definition.stages[stageKey];
  if (!stage) return false;
  for (const input of stage.inputs.filter((candidate) => !candidate.optional)) {
    const edge = definition.edges.find((candidate) => candidate.consumer_stage === stageKey && candidate.consumer_input === input.name);
    if (!edge) return false;
    const available = record.available_artifacts.some((artifact) => artifact.producer_stage_key === edge.producer_stage && artifact.output_name === edge.producer_output);
    if (edge.delivery === "producer_complete" ? !stageFinished(record, edge.producer_stage) : !available && !stageFinished(record, edge.producer_stage)) return false;
  }
  return true;
};

const shouldClose = (stageKey: string, definition: CompiledWorkflowDefinition, record: RunMaterializationRecord): boolean =>
  definition.edges.filter((edge) => edge.consumer_stage === stageKey && edge.delivery === "unit_complete")
    .every((edge) => stageFinished(record, edge.producer_stage));

const selectInputsForUnit = (stage: CompiledStageContract, inputs: Readonly<Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]>>, unit: MaterializedExecutionUnit) => {
  if (stage.materialization.kind !== "fan_out") return inputs;
  const perUnit = new Set(stage.inputs.filter((input) => input.delivery === "unit_complete").map((input) => input.name));
  return Object.fromEntries(Object.entries(inputs).map(([name, value]) =>
    Array.isArray(value) && perUnit.has(name) ? [name, value.filter((artifact) => artifact.unit_id === unit.unit_id)] : [name, value]));
};

const outputSlots = (stage: CompiledStageContract, unit: MaterializedExecutionUnit): readonly MaterializedRunOutput[] => {
  const materialization = stage.materialization;
  if (materialization.kind !== "artifact_collection") return stage.outputs.map((output) => ({ identity: { kind: "scalar", output_name: output.name }, artifact_type: output.artifact_type, required: true, release: output.release }));
  if (!Array.isArray(unit.parameters)) throw new Error(`artifact collection stage '${stage.stage_key}' parameters must be an array`);
  return unit.parameters.flatMap((item) => {
    const key = readJsonPointer(item, materialization.id_path);
    if (typeof key !== "string" || key.length === 0) throw new Error(`artifact collection key '${materialization.id_path}' must be a non-empty string`);
    return stage.outputs.map((output) => ({ identity: { kind: "collection_member" as const, output_name: output.name, collection_key: key as OutputCollectionKey }, artifact_type: output.artifact_type, required: true, release: output.release }));
  });
};

interface ResolveUnitInput {
  readonly run_id: WorkflowRunId;
  readonly stage: CompiledStageContract;
  readonly stage_instance_id: StageInstanceId;
  readonly unit: MaterializedExecutionUnit;
  readonly inputs: Readonly<Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]>>;
  readonly context: JsonValue;
  readonly work_order_id: WorkOrderId;
  readonly capability: string;
}

export interface RunMaterializationDependencies {
  readonly definitions: Pick<WorkflowDefinitionRepository, "find_by_id">;
  readonly records: Pick<RunRecordRepository, "load_materialization_record" | "load_work_order_capability_seed" | "persist_materialized_stage" | "revise_unit_input" | "find_work_order_attachment">;
  load_prompt_template(path: string): Promise<string>;
}

const executionRequest = async (input: ResolveUnitInput, dependencies: RunMaterializationDependencies): Promise<ExecutionRequest> => {
  const unitInputs = selectInputsForUnit(input.stage, input.inputs, input.unit);
  let resolved: JsonValue;
  if (input.stage.executor.executor_type === PROVISION_REPOSITORY_REFS_STAGE_TYPE) {
    const output = input.stage.outputs[0];
    if (!output || input.stage.outputs.length !== 1) throw new Error(`stage '${input.stage.stage_key}' must declare one repository refs output`);
    const definition = input.stage.executor.definition_config as unknown as RepositoryProvisioningDefinitionConfig;
    const branch = resolveBindingValue(definition.base_branch, { inputs: unitInputs, context: input.context, item: null });
    if (!branch.ok) throw new Error(`${branch.error.operation}:${branch.error.detail}`);
    const baseBranch = parseBaseBranch(branch.value);
    const repository = parseRunContextRepository(input.unit.parameters);
    if (!baseBranch.ok) throw new Error(`${baseBranch.error.operation}:${baseBranch.error.detail}`);
    if (!repository.ok) throw new Error(`${repository.error.operation}:${repository.error.detail}`);
    resolved = { executor_type: PROVISION_REPOSITORY_REFS_STAGE_TYPE, output_name: output.name, repository: repository.value, base_branch: baseBranch.value,
      publication: { work_order_id: input.work_order_id, capability: input.capability } } satisfies ResolvedRepositoryProvisioningConfig as unknown as JsonValue;
  } else if (input.stage.executor.executor_type === "delegated_session") {
    const definition = input.stage.executor.definition_config as DelegatedSessionDefinitionConfig;
    const planned = resolveDelegatedExecution({ definition, environment: { inputs: unitInputs, context: input.context, item: input.unit.parameters }, unit: input.unit,
      stage_instance_id: input.stage_instance_id, prompt_template: await dependencies.load_prompt_template(definition.prompt_template_path) });
    if (!planned.ok) throw new Error(`${planned.error.operation}:${planned.error.detail}`);
    const urlBinding = definition.slot_bindings.OAKRIDGE_URL;
    const url = urlBinding ? resolveBinding(urlBinding, { inputs: unitInputs, context: input.context, item: input.unit.parameters }) : null;
    if (!url?.ok) throw new Error(`stage '${input.stage.stage_key}' must resolve OAKRIDGE_URL for work-order publication`);
    resolved = { ...planned.value, publication: { base_url: url.value, work_order_id: input.work_order_id, capability: input.capability } } as unknown as JsonValue;
  } else {
    throw new Error(`executor '${input.stage.executor.executor_type}' has no v2 resolver`);
  }
  let workspace_source: ExecutionRequest["workspace_source"];
  if (input.stage.executor.executor_type === "delegated_session") {
    const definition = input.stage.executor.definition_config as DelegatedSessionDefinitionConfig;
    const inherited = definition.fan_out?.inherit_worktree_from;
    if (inherited) {
      const value = unitInputs[inherited];
      const candidates = value === undefined ? [] : Array.isArray(value) ? value : [value as ArtifactEnvelope];
      const source = candidates.length === 1 ? candidates[0] : null;
      if (!source?.producer_execution_id) throw new Error(`workspace input '${inherited}' for unit '${input.unit.unit_id}' has no unique producer`);
      const attachment = await dependencies.records.find_work_order_attachment(source.producer_execution_id as unknown as WorkOrderId);
      if (!attachment?.external_reference) throw new Error(`workspace source '${source.producer_execution_id}' has no executor attachment`);
      workspace_source = { execution_id: source.producer_execution_id, external_reference: attachment.external_reference as ExternalExecutionReference };
    }
  }
  const slots = outputSlots(input.stage, input.unit);
  return { execution_id: input.work_order_id as unknown as ExecutionRequest["execution_id"], stage_instance_id: input.stage_instance_id, unit_id: input.unit.unit_id,
    executor_type: input.stage.executor.executor_type, resolved_config: resolved, inputs: envelopes(unitInputs),
    declared_outputs: input.stage.outputs.map((output) => ({ name: output.name, artifact_type: output.artifact_type, required: true })),
    expected_artifacts: slots.map((slot) => ({ unit_id: slot.identity.kind === "collection_member" ? slot.identity.collection_key as unknown as UnitId : input.unit.unit_id,
      output_name: slot.identity.output_name, artifact_type: slot.artifact_type })), ...(workspace_source ? { workspace_source } : {}) };
};

const workOrderFor = async (input: Omit<ResolveUnitInput, "work_order_id" | "capability"> & { readonly identity: string; readonly capability_seed: string }, dependencies: RunMaterializationDependencies): Promise<MaterializedWorkOrder> => {
  const id = stableUuid(`${input.run_id}:${input.stage.stage_key}:${input.unit.unit_id}:${input.identity}`) as WorkOrderId;
  const capability = capabilityFor(input.capability_seed, id);
  return { id, workflow_id: `v2-work:${id}`, capability_hash: capabilityHash(capability), request: await executionRequest({ ...input, work_order_id: id, capability }, dependencies) };
};

interface MaterializationProgress { stage_key: string | null }

const applyRunMaterialization = async (run_id: WorkflowRunId, materialized_at: string, dependencies: RunMaterializationDependencies, progress: MaterializationProgress): Promise<void> => {
  let record = await dependencies.records.load_materialization_record(run_id);
  if (!record) throw new Error(`workflow run '${run_id}' was not found`);
  if (record.run.state !== "active") return;
  const definition = await dependencies.definitions.find_by_id(record.run.workflow_definition_id);
  if (!definition || definition.version !== record.run.workflow_definition_version) throw new Error(`workflow definition for run '${run_id}' is unavailable`);
  const compiled = compileWorkflowDefinition(definition);
  if (!compiled.ok) throw new Error(`${compiled.error.operation}:${compiled.error.stage_key ?? "workflow"}:${compiled.error.detail}`);

  const capabilitySeed = await dependencies.records.load_work_order_capability_seed();
  for (const stageKey of Object.keys(compiled.value.stages).sort()) {
    progress.stage_key = stageKey;
    const stage = compiled.value.stages[stageKey]!;
    const stageId = stableUuid(`${run_id}:stage:${stageKey}`) as StageInstanceId;
    const stored = record.stages.find((candidate) => candidate.stage_key === stageKey);
    const ready = isReady(stageKey, compiled.value, record);
    const inputs = stageInputs(stageKey, compiled.value, record);
    const materialized = ready ? materializeStage(stage, { inputs, context: record.run.context, item: null }) : { ok: true as const, value: [] as readonly MaterializedExecutionUnit[] };
    if (!materialized.ok) throw new Error(`${materialized.error.operation}:${materialized.error.stage_key}:${materialized.error.detail}`);
    const newUnits: PersistMaterializedStage["units"][number][] = [];
    const revisions: { readonly run_unit_id: RunUnitId; readonly input_snapshot: readonly ArtifactEnvelope[]; readonly input_fingerprint: InputFingerprint; readonly replacement_work_order: MaterializedWorkOrder }[] = [];
    for (const unit of materialized.value) {
      const unitInputs = selectInputsForUnit(stage, inputs, unit);
      const snapshot = envelopes(unitInputs);
      const fingerprint = fingerprintOf(snapshot);
      const existing = stored?.units.find((candidate) => candidate.unit_id === unit.unit_id);
      const base = { run_id, stage, stage_instance_id: stageId, unit, inputs, context: record.run.context };
      if (existing) {
        if (existing.input_fingerprint !== fingerprint) revisions.push({ run_unit_id: existing.id, input_snapshot: snapshot, input_fingerprint: fingerprint,
          replacement_work_order: await workOrderFor({ ...base, identity: `revision:${fingerprint}`, capability_seed: capabilitySeed }, dependencies) });
        continue;
      }
      newUnits.push({ id: stableUuid(`${run_id}:${stageKey}:unit:${unit.unit_id}`) as RunUnitId, unit_id: unit.unit_id, parameters: unit.parameters,
        input_snapshot: snapshot, input_fingerprint: fingerprint, depends_on: unit.depends_on, outputs: outputSlots(stage, unit),
        initial_work_order: await workOrderFor({ ...base, identity: "initial", capability_seed: capabilitySeed }, dependencies) });
    }
    const materialization = stage.materialization;
    await dependencies.records.persist_materialized_stage({ run_id, stage_instance_id: stageId, stage_key: stage.stage_key, stage_type: stage.stage_type,
      stage_contract: stage, units: newUnits,
      policy: { max_parallel: materialization.kind === "fan_out" ? materialization.max_parallel : 1,
        manual_admission: materialization.kind === "fan_out" ? materialization.manual_admission : false },
      close_materialization: ready && shouldClose(stageKey, compiled.value, record), materialized_at });
    for (const revision of revisions) await dependencies.records.revise_unit_input({ ...revision, revised_at: materialized_at, actor: "compiler" });
    record = await dependencies.records.load_materialization_record(run_id) ?? record;
  }
};

export interface RunMaterializationError {
  readonly operation: "reconcile_run_materialization";
  readonly kind: "authoring" | "infrastructure";
  readonly run_id: WorkflowRunId;
  readonly stage_key: string | null;
  readonly detail: string;
}

const isInfrastructureFailure = (cause: unknown): boolean => {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  return ["40001", "40P01", "55P03", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08004", "08006", "08007", "08P01"].includes(code);
};

/** IO failures and authored materialization failures cross the workflow step as values. */
export const reconcileRunMaterialization = async (
  run_id: WorkflowRunId,
  materialized_at: string,
  dependencies: RunMaterializationDependencies,
): Promise<Result<void, RunMaterializationError>> => {
  const progress: MaterializationProgress = { stage_key: null };
  try {
    await applyRunMaterialization(run_id, materialized_at, dependencies, progress);
    return ok(undefined);
  } catch (cause) {
    return err({ operation: "reconcile_run_materialization", kind: isInfrastructureFailure(cause) ? "infrastructure" : "authoring", run_id, stage_key: progress.stage_key,
      detail: cause instanceof Error ? cause.message : String(cause) });
  }
};
