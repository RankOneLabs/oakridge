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
 * Every `throw` here stays a `throw`: a missing prompt file or a producer
 * attachment not yet written is an operational failure (spec §3.4.1) that
 * must propagate out of `decide_run`'s transaction, not become a domain
 * outcome.
 */
import { createHash } from "node:crypto";

import { resolveBinding, resolveBindingValue, resolveDelegatedExecution } from "../compiler/resolve-execution";
import type { StageInputSet } from "../decision/commands";
import { workOrderIdFor, workOrderWorkflowId } from "../decision/ids";
import type { CompiledStageContract, MaterializedExecutionUnit } from "../domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import type { AssessmentRevisionContext } from "../domain/dev-flow-artifacts";
import type { ArtifactEnvelope, ExecutionRequest, ExternalExecutionReference } from "../domain/execution";
import type { ArtifactId, JsonValue, OutputCollectionKey, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import { PROVISION_REPOSITORY_REFS_STAGE_TYPE, parseBaseBranch, parseRunContextRepository, type RepositoryProvisioningDefinitionConfig, type ResolvedRepositoryProvisioningConfig } from "../domain/repository-refs";
import type { ExecutorAttachment, MaterializedRunOutput, MaterializedWorkOrder } from "../domain/run-record";

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
  readonly context: JsonValue;
  readonly outputs: readonly MaterializedRunOutput[];
  /** `"initial"` or `"revision:<fingerprint>"` — spec §13. */
  readonly identity: string;
  readonly capability_seed: string;
}

export interface ResolveWorkOrderDependencies {
  load_prompt_template(path: string): Promise<string>;
  find_work_order_attachment(id: WorkOrderId): Promise<ExecutorAttachment | null>;
}

interface ExecutionRequestInput extends ResolveWorkOrderInput { readonly work_order_id: WorkOrderId; readonly capability: string }

const executionRequest = async (input: ExecutionRequestInput, dependencies: ResolveWorkOrderDependencies): Promise<ExecutionRequest> => {
  const unitInputs = input.inputs;
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
      stage_instance_id: input.stage_instance_id, prompt_template: await dependencies.load_prompt_template(definition.prompt_template_path),
      run_id: input.run_id, operator_role: input.stage.operator_role });
    if (!planned.ok) throw new Error(`${planned.error.operation}:${planned.error.detail}`);
    const urlBinding = definition.slot_bindings.OAKRIDGE_URL;
    const url = urlBinding ? resolveBinding(urlBinding, { inputs: unitInputs, context: input.context, item: input.unit.parameters }) : null;
    if (!url?.ok) throw new Error(`stage '${input.stage.stage_key}' must resolve OAKRIDGE_URL for work-order publication`);
    resolved = { ...planned.value, session_name: input.work_order_id,
      publication: { base_url: url.value, work_order_id: input.work_order_id, capability: input.capability } } as unknown as JsonValue;
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
      const attachment = await dependencies.find_work_order_attachment(source.producer_execution_id as unknown as WorkOrderId);
      if (!attachment?.external_reference) throw new Error(`workspace source '${source.producer_execution_id}' has no executor attachment`);
      workspace_source = { execution_id: source.producer_execution_id, external_reference: attachment.external_reference as ExternalExecutionReference };
    }
  }
  return { execution_id: input.work_order_id as unknown as ExecutionRequest["execution_id"], stage_instance_id: input.stage_instance_id, unit_id: input.unit.unit_id,
    executor_type: input.stage.executor.executor_type, resolved_config: resolved, inputs: envelopes(unitInputs),
    declared_outputs: input.stage.outputs.map((output) => ({ name: output.name, artifact_type: output.artifact_type, required: true })),
    expected_artifacts: input.outputs.map((output) => ({
      unit_id: output.identity.kind === "collection_member" ? (output.identity.collection_key as unknown as UnitId) : input.unit.unit_id,
      output_name: output.identity.output_name, artifact_type: output.artifact_type,
    })), ...(workspace_source ? { workspace_source } : {}) };
};

export const resolveWorkOrder = async (input: ResolveWorkOrderInput, dependencies: ResolveWorkOrderDependencies): Promise<MaterializedWorkOrder> => {
  const id = workOrderIdFor(input.run_id, input.stage.stage_key, input.unit.unit_id, input.identity);
  const capability = capabilityFor(input.capability_seed, id);
  return { id, workflow_id: workOrderWorkflowId(id), capability_hash: capabilityHash(capability), request: await executionRequest({ ...input, work_order_id: id, capability }, dependencies) };
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

/** The cohort branch a basis request asked kbbl to create, when it named one. */
const selectWorktreeBranchName = (config: { readonly [key: string]: JsonValue }): string | null => {
  const worktree = config.worktree;
  if (!isJsonObject(worktree)) return null;
  return typeof worktree.branchName === "string" && worktree.branchName.length > 0 ? worktree.branchName : null;
};

/**
 * A retry that inherits the previous writer's checkout starts on kbbl's
 * scratch fork branch, while the rendered prompt still reads as a first build
 * that pushes "the current branch" and opens a PR. This section moves the
 * session back onto the cohort branch, whose PR is already open, so the
 * correction lands on that PR instead of a new one.
 */
const selectCohortBranchContinuationSection = (branch: string): string =>
  `## Continue the cohort branch\n\nThis session continues cohort branch \`${branch}\`. Your worktree starts from the previous session's last commit, but on a scratch branch. Before you commit anything, switch to the cohort branch at your current commit:\n\n\`\`\`sh\ngit checkout --ignore-other-worktrees -B ${branch}\n\`\`\`\n\nCommit your changes on \`${branch}\` and push it with \`mcp__gated-review__git_push\`. If the push is rejected as non-fast-forward, run \`mcp__gated-review__git_pull\`, resolve any conflict, and push again. Emit only the artifacts listed in the publication section below. When that list does not include \`pr_summary\`, the cohort's pull request is already open from this branch and picks up the push: do not call \`mcp__gated-review__open_pr\` and do not emit \`pr_summary\`. Only when the list asks for \`pr_summary\` is no pull request recorded yet; then open one from this branch as described above. This overrides the push, open-PR and emit-order steps above.`;

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
  const cohortBranch = input.retry_workspace_source ? selectWorktreeBranchName(config) : null;
  const sections = [
    ...(rejected.length > 0 ? [selectCorrectionSection(rejected, input.review ?? null)] : []),
    ...(cohortBranch ? [selectCohortBranchContinuationSection(cohortBranch)] : []),
  ];
  const resolved_config: JsonValue = sections.length > 0 && typeof config.rendered_prompt === "string"
    ? { ...retryConfig, rendered_prompt: [config.rendered_prompt, ...sections].join("\n\n") }
    : retryConfig;
  return {
    capability_hash: capabilityHash(capability),
    request: { ...input.basis, execution_id: input.work_order_id as unknown as ExecutionRequest["execution_id"], resolved_config, expected_artifacts,
      ...(input.retry_workspace_source ? { workspace_source: input.retry_workspace_source } : {}) },
  };
};
