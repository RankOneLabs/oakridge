/**
 * Resolves the execution request a work order carries at materialization or
 * revision time — spec §3.4.1, moved verbatim from `run-materialization.ts`'s
 * `executionRequest` + `workOrderFor` (lines 97-149 on `9ce75fd`). `apply`
 * (`postgres-run-record.ts`) is this module's only caller: `derive` already
 * decided a unit needs a work order and handed `apply` its per-unit inputs,
 * so resolution here never re-derives what `derive` computed.
 *
 * Differences from the old `run-materialization.ts` version:
 * - `selectInputsForUnit` is dropped — `input.inputs` arrives already
 *   filtered to the unit (`derive`'s own copy of that filter).
 * - `expected_artifacts` is built from `input.outputs` (the command's own
 *   `MaterializedRunOutput[]`), not a second `outputSlots` computation.
 * - Ids come from `src/decision/ids` (`workOrderIdFor`, `workOrderWorkflowId`)
 *   so a work order's id is deterministic the same way every other decision
 *   id is (spec §13) — never random.
 *
 * Every `throw` here stays a `throw`: a missing pinned prompt bundle or a producer
 * attachment not yet written is an operational failure (spec §3.4.1) that
 * must propagate out of `decide_run`'s transaction, not become a domain
 * outcome.
 */
import { createHash } from "node:crypto";

import { resolveBinding, resolveBindingValue, resolveDelegatedExecution } from "../compiler/resolve-execution";
import type { StageInputSet } from "../decision/commands";
import { workOrderIdFor, workOrderWorkflowId } from "../decision/ids";
import type { CompiledStageContract, MaterializedExecutionUnit } from "../domain/compiled-workflow";
import type { CommittedSessionLaunch, DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import type { AssessmentRevisionContext } from "../domain/dev-flow-artifacts";
import type { DevFlowBuildCohort } from "../domain/cohort-pull-request";
import type { ArtifactEnvelope, ExecutionRequest } from "../domain/execution";
import type { ArtifactId, JsonValue, OutputCollectionKey, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import { PROVISION_REPOSITORY_REFS_STAGE_TYPE, parseBaseBranch, parseRunContextRepository, renderCohortBranchContract, type RepositoryProvisioningDefinitionConfig, type ResolvedRepositoryProvisioningConfig } from "../domain/repository-refs";
import type { MaterializedRunOutput, MaterializedWorkOrder } from "../domain/run-record";

const capabilityFor = (seed: string, workOrderId: WorkOrderId): string => createHash("sha256").update(seed).update(":").update(workOrderId).digest("base64url");
const capabilityHash = (capability: string): string => createHash("sha256").update(capability).digest("hex");

const envelopes = (inputs: StageInputSet): readonly ArtifactEnvelope[] =>
  Object.values(inputs).flatMap((value) => (Array.isArray(value) ? value : [value as ArtifactEnvelope]));

export interface ResolveWorkOrderInput {
  readonly run_id: WorkflowRunId;
  readonly stage: CompiledStageContract;
  readonly stage_instance_id: StageInstanceId;
  readonly unit: MaterializedExecutionUnit;
  /** Already per-unit — `derive`'s own `selectInputsForUnit`, not re-filtered here. */
  readonly inputs: StageInputSet;
  /**
   * Accepted outputs already persisted for this cohort and unit. The build
   * adapter's c8 composition loads these from run_output_slot before launching
   * a later role; keeping them separate prevents same-stage outputs from being
   * mistaken for graph inputs.
   */
  readonly accepted_cohort_outputs?: readonly ArtifactEnvelope[];
  readonly context: JsonValue;
  readonly outputs: readonly MaterializedRunOutput[];
  /** `"initial"` or `"revision:<fingerprint>"` — spec §13. */
  readonly identity: string;
  readonly capability_seed: string;
  /** Role, reason and prompt selected atomically by the launch transition. */
  readonly session_launch: CommittedSessionLaunch;
  /** Stored adapter row used verbatim for the build/assessment branch contract. */
  readonly build_cohort?: DevFlowBuildCohort;
}

interface ExecutionRequestInput extends ResolveWorkOrderInput { readonly work_order_id: WorkOrderId; readonly capability: string }

const inputsForSessionLaunch = (input: ExecutionRequestInput): StageInputSet => {
  if (input.session_launch.session_role !== "assessment") return input.inputs;
  const accepted = (input.accepted_cohort_outputs ?? []).filter((artifact) => artifact.unit_id === input.unit.unit_id);
  if (accepted.length === 0) return input.inputs;
  const grouped: Record<string, ArtifactEnvelope[]> = {};
  for (const artifact of accepted) (grouped[artifact.output_name] ??= []).push(artifact);
  return { ...input.inputs, ...grouped };
};

const executionRequest = async (input: ExecutionRequestInput): Promise<ExecutionRequest> => {
  const unitInputs = input.stage.executor.executor_type === "delegated_session" ? inputsForSessionLaunch(input) : input.inputs;
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
    const committed = input.session_launch;
    const declared = definition.prompt_matrix.filter((entry) => entry.session_role === committed.session_role
      && entry.launch_reason === committed.reason.name && entry.template_path === committed.prompt.template_path);
    if (declared.length !== 1) throw new Error(`stage '${input.stage.stage_key}' does not declare committed prompt ${committed.session_role}:${committed.reason.name}`);
    const planned = resolveDelegatedExecution({ definition, environment: { inputs: unitInputs, context: input.context, item: input.unit.parameters }, unit: input.unit,
      stage_instance_id: input.stage_instance_id, prompt_template: committed.prompt.content,
      run_id: input.run_id, operator_role: committed.session_role, launch_reason: committed.reason.name,
      existing_pull_request: committed.existing_pull_request });
    if (!planned.ok) throw new Error(`${planned.error.operation}:${planned.error.detail}`);
    const urlBinding = definition.slot_bindings.OAKRIDGE_URL;
    const url = urlBinding ? resolveBinding(urlBinding, { inputs: unitInputs, context: input.context, item: input.unit.parameters }) : null;
    if (!url?.ok) throw new Error(`stage '${input.stage.stage_key}' must resolve OAKRIDGE_URL for work-order publication`);
    const renderedPrompt = input.build_cohort
      ? `${planned.value.rendered_prompt}\n\n${renderCohortBranchContract(input.build_cohort)}`
      : planned.value.rendered_prompt;
    resolved = { ...planned.value, rendered_prompt: renderedPrompt, session_name: input.work_order_id,
      publication: { base_url: url.value, work_order_id: input.work_order_id, capability: input.capability } } as unknown as JsonValue;
  } else {
    throw new Error(`executor '${input.stage.executor.executor_type}' has no v2 resolver`);
  }
  return { execution_id: input.work_order_id as unknown as ExecutionRequest["execution_id"], stage_instance_id: input.stage_instance_id, unit_id: input.unit.unit_id,
    executor_type: input.stage.executor.executor_type, resolved_config: resolved, inputs: envelopes(unitInputs),
    declared_outputs: input.stage.outputs.map((output) => ({ name: output.name, artifact_type: output.artifact_type, required: true })),
    expected_artifacts: input.outputs.map((output) => ({
      unit_id: output.identity.kind === "collection_member" ? (output.identity.collection_key as unknown as UnitId) : input.unit.unit_id,
      output_name: output.identity.output_name, artifact_type: output.artifact_type,
    })), ...(input.stage.executor.executor_type === "delegated_session" ? { session_launch: input.session_launch } : {}) };
};

export const resolveWorkOrder = async (input: ResolveWorkOrderInput): Promise<MaterializedWorkOrder> => {
  const id = workOrderIdFor(input.run_id, input.stage.stage_key, input.unit.unit_id, input.identity);
  const capability = capabilityFor(input.capability_seed, id);
  return { id, workflow_id: workOrderWorkflowId(id), capability_hash: capabilityHash(capability), request: await executionRequest({ ...input, work_order_id: id, capability }) };
};

/** One required output slot a retried unit still owes, as `retry_unit` reads it off `run_output_slot`. */
export interface MissingOutputSlot {
  readonly output_name: string;
  readonly collection_key: OutputCollectionKey | null;
}

/** Rejected artifact and feedback from run_output_slot and its referenced artifact row. */
export interface RejectedOutputContext extends MissingOutputSlot {
  readonly artifact_id: ArtifactId;
  readonly body: JsonValue;
  readonly feedback: string | null;
}

export interface RebindWorkOrderPublicationInput {
  /** The latest execution request the unit ran under — prompt, workdir, inputs are reused as they were resolved. */
  readonly basis: ExecutionRequest;
  readonly work_order_id: WorkOrderId;
  readonly capability_seed: string;
  readonly missing: readonly MissingOutputSlot[];
  readonly rejected_outputs?: readonly RejectedOutputContext[];
  /** The assessment the operator sent back, rendered beside the rejected outputs. */
  readonly review?: AssessmentRevisionContext;
  /** The previous writer's checkout is the retry's base when that writer reached kbbl. */
  readonly retry_workspace_source?: ExecutionRequest["workspace_source"];
}

export interface ReboundWorkOrderPublication {
  readonly request: ExecutionRequest;
  readonly capability_hash: string;
}

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The section a retry's prompt gains: the rejected outputs with the operator's
 * feedback, then, when an assessment was sent back, its open findings and
 * recommendations, subordinate to that feedback.
 */
const selectCorrectionSection = (rejected: readonly RejectedOutputContext[], review: AssessmentRevisionContext | null): string => {
  const corrections = `## Requested output corrections\n\nThe previous writer is being replaced. Revise these stored outputs according to the operator feedback; preserve the remaining scope. Publish using the new work-order instructions below.\n\n${JSON.stringify(rejected, null, 2)}`;
  if (!review) return corrections;
  return `${corrections}\n\n## Assessment sent back by the operator\n\nThe assessor reviewed the previous build and the operator sent it back for changes. Address its open findings and recommended next actions below; where the operator feedback above differs from them, follow the operator feedback.\n\n${JSON.stringify(review, null, 2)}`;
};

/**
 * Derives a retry's execution request from the basis request. Everything that
 * names the work order is re-minted, never copied: the execution id, the
 * publication target the executor PUTs to, and the capability that authorizes
 * it — from the same durable seed `resolveWorkOrder` uses, so a capability
 * issued to one work order never authenticates another. `expected_artifacts`
 * narrows to the slots still owed, so the relaunched agent is told to emit
 * those and nothing else (the adapter renders this list into its prompt).
 *
 * `null` when the basis carries no publication authority, or declares no
 * output for a slot that is missing — either is a request this unit cannot be
 * retried from, which `retry_unit` reports as `no_execution_basis`.
 */
export const rebindWorkOrderPublication = (input: RebindWorkOrderPublicationInput): ReboundWorkOrderPublication | null => {
  const config = input.basis.resolved_config;
  if (!isJsonObject(config)) return null;
  const publication = config.publication;
  if (!isJsonObject(publication)) return null;
  const expected_artifacts: ExecutionRequest["expected_artifacts"][number][] = [];
  for (const slot of input.missing) {
    const declared = input.basis.declared_outputs.find((output) => output.name === slot.output_name);
    if (!declared) return null;
    expected_artifacts.push({
      unit_id: slot.collection_key === null ? input.basis.unit_id : (slot.collection_key as unknown as UnitId),
      output_name: slot.output_name, artifact_type: declared.artifact_type,
    });
  }
  const capability = capabilityFor(input.capability_seed, input.work_order_id);
  const rejected = input.rejected_outputs ?? [];
  const reboundConfig = { ...config,
    ...(typeof config.session_name === "string" ? { session_name: input.work_order_id } : {}),
    publication: { ...publication, work_order_id: input.work_order_id, capability } };
  // A named cohort branch is still owned by the previous session. A retry
  // inherits that session's checkout and must not ask kbbl to create the same
  // branch a second time.
  const retryConfig: { [key: string]: JsonValue } = { ...reboundConfig };
  if (input.retry_workspace_source) delete retryConfig.worktree;
  const resolved_config: JsonValue = rejected.length > 0 && typeof config.rendered_prompt === "string"
    ? { ...retryConfig, rendered_prompt: `${config.rendered_prompt}\n\n${selectCorrectionSection(rejected, input.review ?? null)}` }
    : retryConfig;
  return {
    capability_hash: capabilityHash(capability),
    request: { ...input.basis, execution_id: input.work_order_id as unknown as ExecutionRequest["execution_id"], resolved_config, expected_artifacts,
      ...(input.retry_workspace_source ? { workspace_source: input.retry_workspace_source } : {}) },
  };
};
