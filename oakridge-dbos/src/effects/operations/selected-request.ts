import { INPUT_CONTRACTS } from "../provider-catalog";
import type { Action, Worker, Workflow } from "../../core-client/core-types";
import type { ExecutionRequest } from "../../domain/execution";
import type { ExecutionId, ExecutorOperationId, JsonValue, StageInstanceId, UnitId } from "../../domain/primitives";
import { renderSessionStart } from "../../adapters/kbbl";
import type { Result } from "../../storage/commit";
import type { UnitRecord } from "../../storage/schema-records";
import type { StableInvocation } from "../provider";
import type { PromptTexts } from "../../storage/prompt-content";
import { defaultModelForRuntime, type RuntimeId } from "../../../../kbbl/core/runtime";
import { resolveSessionSettings, type SessionInvocationSettings, type SessionPolicy } from "../../domain/session-settings";

/** The unit fields a provider request reads; the rest of the row is irrelevant here. */
export type RequestUnit = Pick<UnitRecord, "id" | "run_id" | "stage" | "collection_key" | "declaration" | "input">;

/** `prompts` holds the stored text of every prompt the action selected; a render never reads a prompt file. */
export interface ProviderRequestSelection {
  readonly invocation: StableInvocation;
  readonly workflow: Workflow;
  readonly prompts: PromptTexts;
  readonly unit: RequestUnit;
  readonly publication_secret?: string;
}

type RunWorker = Extract<Action, { readonly kind: "run_worker" }>;
const runWorkerAction = (selection: Action): RunWorker | null => selection.kind === "run_worker" ? selection : null;

/** The worker a stage declares under the action's worker key. */
export function workerDeclaration(workflow: Workflow, stage: string | null, worker_key: string): Worker | null {
  if (stage === null) return null;
  return workflow.stages[stage]?.workers[worker_key] ?? null;
}

const runtimeOf = (worker: Extract<Worker, { readonly kind: "agent" }>): RuntimeId =>
  worker.runtime?.harness === "codex" ? "codex" : "claude-code";

/** Resolve from the stage's worker declaration and the policy read by the committing transaction. */
export function resolveSelectedSessionSettings(workflow: Workflow, selection: Action, unit: RequestUnit, policy: SessionPolicy): Result<SessionInvocationSettings | null> {
  const action = runWorkerAction(selection);
  if (!action) return { ok: true, value: null };
  const worker = workerDeclaration(workflow, unit.stage, action.worker);
  if (!worker || worker.kind !== "agent") return { ok: true, value: null };
  const runtime = runtimeOf(worker);
  const other_runtime: RuntimeId = runtime === "codex" ? "claude-code" : "codex";
  const resolved = resolveSessionSettings(policy, {
    stage_key: unit.stage ?? unit.declaration, worker_key: action.worker,
    worker_defaults: [{ runtime, model: worker.runtime?.model ?? defaultModelForRuntime(runtime) },
      { runtime: other_runtime, model: defaultModelForRuntime(other_runtime) }],
  });
  if (!resolved.ok) return { ok: false, error: { operation: resolved.error.operation, entity_id: resolved.error.entity_id, detail: resolved.error.detail } };
  return { ok: true, value: { runtime: resolved.value.runtime, model: resolved.value.model, effort: resolved.value.effort, policy_version: policy.version } };
}

/** Keep the selected action input in the pinned prompt so retries read identical context. */
export function promptWithActionInput(prompt: string, input: JsonValue): string {
  return `${prompt}\n\n## Pinned action input\n\n${JSON.stringify(input, null, 2)}\n`;
}

export function pinProviderRequest(input: ProviderRequestSelection): Result<StableInvocation> {
  const { invocation, workflow, prompts, unit } = input;
  const reject = (detail: string): Result<never> => ({ ok: false, error: { operation: "pin_request", entity_id: invocation.id, detail } });
  const action = runWorkerAction(invocation.selection);
  if (!action) return { ok: true, value: { ...invocation, bytes: JSON.stringify(invocation.selection), request: { version: 1, kind: INPUT_CONTRACTS.stub } } };

  const worker = workerDeclaration(workflow, unit.stage, action.worker);
  if (!worker) return reject("pinned worker declaration missing");

  if (worker.kind === "code") {
    const kind = worker.operation === "repository.prepare" ? INPUT_CONTRACTS.repository
      : worker.operation === "pull_request.observe" ? INPUT_CONTRACTS.pull_request : INPUT_CONTRACTS.stub;
    return { ok: true, value: { ...invocation, bytes: JSON.stringify(unit.input ?? null), request: { version: 1, kind } } };
  }

  // An agent's prompt slot is its mode: initial, revise or review.
  const prompt_key = worker.prompts[action.mode.kind];
  if (prompt_key === undefined) return reject(`worker declares no ${action.mode.kind} prompt`);
  const prompt_content = prompts.get(prompt_key);
  if (prompt_content === undefined) return reject("pinned prompt missing");

  const request: ExecutionRequest = {
    execution_id: invocation.execution_id as ExecutionId,
    stage_instance_id: unit.id as string as StageInstanceId,
    unit_id: unit.id as string as UnitId,
    executor_type: "delegated_session",
    resolved_config: {
      runtime: invocation.session_settings?.runtime ?? runtimeOf(worker),
      model: invocation.session_settings?.model ?? null,
      effort: invocation.session_settings?.effort ?? null,
      workspace: worker.workspace ?? null,
      session_mode: worker.session ?? "fresh",
      session_identity: { run_id: unit.run_id, stage_instance_id: unit.id, unit_id: unit.id,
        cohort_id: unit.collection_key, operator_role: action.worker },
      rendered_prompt: promptWithActionInput(prompt_content, (unit.input ?? null) as JsonValue),
    },
    inputs: [], declared_outputs: [], expected_artifacts: [],
  };
  const rendered = renderSessionStart({ request, operation_id: invocation.id as unknown as ExecutorOperationId, executor_function_identity: action.worker });
  if (rendered.kind !== "acknowledged") return reject(rendered.detail);
  return { ok: true, value: { ...invocation, bytes: rendered.value.body,
    request: { version: 1, kind: INPUT_CONTRACTS.session, session_key: rendered.value.session_key } } };
}
