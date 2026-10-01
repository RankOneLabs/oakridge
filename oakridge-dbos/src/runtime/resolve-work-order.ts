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
import type { DevFlowBuildCohort } from "../domain/cohort-pull-request";
import type { ArtifactEnvelope, ExecutionRequest } from "../domain/execution";
import type { JsonValue, StageInstanceId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import { PROVISION_REPOSITORY_REFS_STAGE_TYPE, parseBaseBranch, parseRunContextRepository, renderCohortBranchContract, type RepositoryProvisioningDefinitionConfig, type ResolvedRepositoryProvisioningConfig } from "../domain/repository-refs";
import type { DeclaredOutputSlot } from "../domain/run-record";

/**
 * A resolved execution and the authority it publishes under.
 *
 * v14 called this a materialized work order. v15's unit of execution is an
 * attempt; the shape is the same because what a resolver produces has not
 * changed — an id, the durable workflow that drives it, the hash of the
 * capability it was issued, and the request itself.
 */
export interface ResolvedAttemptExecution {
  readonly id: WorkOrderId;
  readonly workflow_id: string;
  readonly capability_hash: string;
  readonly request: ExecutionRequest;
}

/**
 * The publication capability one execution holds.
 *
 * Derived from the durable seed and the execution's own id rather than stored,
 * so a capability issued to one attempt can never authenticate another, and a
 * replayed resolution mints the identical value. The storage boundary derives
 * the expected hash the same way when it checks an incoming publication — there
 * is no `capability_hash` column for the two to disagree about.
 */
export const capabilityFor = (seed: string, workOrderId: WorkOrderId): string => createHash("sha256").update(seed).update(":").update(workOrderId).digest("base64url");
export const capabilityHash = (capability: string): string => createHash("sha256").update(capability).digest("hex");

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
  /** The slots this execution is expected to fill, read off the stage's pinned contract. */
  readonly outputs: readonly DeclaredOutputSlot[];
  /** `"initial"` or `"revision:<fingerprint>"` — spec §13. */
  readonly identity: string;
  readonly capability_seed: string;
  /**
   * Role, reason and prompt selected atomically by the launch transition.
   * Absent for a deterministic stage, which has no session and no role to pick.
   */
  readonly session_launch?: CommittedSessionLaunch;
  /** Stored adapter row used verbatim for the build/assessment branch contract. */
  readonly build_cohort?: DevFlowBuildCohort;
}

interface ExecutionRequestInput extends ResolveWorkOrderInput { readonly work_order_id: WorkOrderId; readonly capability: string }

const inputsForSessionLaunch = (input: ExecutionRequestInput): StageInputSet => {
  if (input.session_launch?.session_role !== "assessment") return input.inputs;
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
    if (!committed) throw new Error(`stage '${input.stage.stage_key}' is a delegated session with no committed launch`);
    const declared = definition.prompt_matrix.filter((entry) => entry.session_role === committed.session_role
      && entry.launch_reason === committed.reason.name && entry.template_path === committed.prompt.template_path);
    if (declared.length !== 1) throw new Error(`stage '${input.stage.stage_key}' does not declare committed prompt ${committed.session_role}:${committed.reason.name}`);
    const planned = resolveDelegatedExecution({ definition, environment: { inputs: unitInputs, context: input.context, item: input.unit.parameters }, unit: input.unit,
      stage_instance_id: input.stage_instance_id, prompt_template: committed.prompt.content,
      run_id: input.run_id, cohort_id: input.build_cohort?.cohort_id ?? null,
      operator_role: committed.session_role, launch_reason: committed.reason.name,
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
      unit_id: input.unit.unit_id, output_name: output.output_name, artifact_type: output.artifact_type,
    })), ...(input.stage.executor.executor_type === "delegated_session" ? { session_launch: input.session_launch } : {}) };
};

/**
 * Resolves the execution one attempt will run, under an id the caller supplies.
 *
 * The id is the attempt's, minted by `attemptIdFor` from the cohort and attempt
 * number so a replayed launch dispatch resolves the identical request — the
 * capability included, since it is derived from the id rather than generated.
 */
export const resolveAttemptExecution = async (
  input: ResolveWorkOrderInput & { readonly attempt_id: WorkOrderId; readonly attempt_workflow_id: string },
): Promise<ResolvedAttemptExecution> => {
  const capability = capabilityFor(input.capability_seed, input.attempt_id);
  return { id: input.attempt_id, workflow_id: input.attempt_workflow_id, capability_hash: capabilityHash(capability),
    request: await executionRequest({ ...input, work_order_id: input.attempt_id, capability }) };
};

/** The v14 entry point, retained for callers that still mint their own id. */
export const resolveWorkOrder = async (input: ResolveWorkOrderInput): Promise<ResolvedAttemptExecution> => {
  const id = workOrderIdFor(input.run_id, input.stage.stage_key, input.unit.unit_id, input.identity);
  return resolveAttemptExecution({ ...input, attempt_id: id, attempt_workflow_id: workOrderWorkflowId(id) });
};
