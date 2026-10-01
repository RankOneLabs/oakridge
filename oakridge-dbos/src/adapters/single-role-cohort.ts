/**
 * The cohort machine for a one-role review loop.
 *
 * Every planning stage in dev-flow is this shape: one session role, one gated
 * output, and a revision that relaunches the same role. `dev-flow-build.ts` is
 * deliberately *not* this — it carries two roles and two sequential gates, and
 * its prompt matrix validation requires the whole `build`/`assessment` roster —
 * so pointing a planning stage at it fails before it can run.
 *
 * The role and its reasons come from the stage's own declared prompt matrix, so
 * a stage that declares one reason (`final_integration`) and one that declares
 * three (`spec_analyzer`) both run here without either being special-cased.
 */
import { attemptWorkflowId } from "../decision/ids";
import type { CompiledStageContract } from "../domain/compiled-workflow";
import type { CommittedSessionLaunch, DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import { selectArtifactGateDisposition, selectBuiltInGateDisposition } from "../domain/gates";
import type { AttemptId, JsonValue, RunTransitionId, UnitId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import { hasOwn, readOwn } from "../domain/records";
import type { BlockedReason, CoreStatus, NextActor } from "../domain/records";
import type { OpenCohort } from "../domain/run-record";
import type { PromptBundleEntry } from "../domain/workflow";
import { resolveAttemptExecution } from "../runtime/resolve-work-order";
import type { RunRecordRepository } from "../storage/repositories";
import type { CohortMachineDriver, CohortStepContext, CohortStepDecision } from "../workflows/run-record-topology";
import { cohortIdFor, resolveCohortRoster, selectAcceptedCollectionDependencyCycle, selectCohortOutputsSatisfied } from "./cohort-roster";

/** The reason a first launch uses, and the one a rejected gate relaunches under. */
const INITIAL_REASON = "initial";
const REVISION_REASON = "input_revision";

/** `oakridge.cohort.stage_data` for a one-role cohort. */
interface SingleRoleCohortStageData {
  readonly unit_id: string;
  readonly artifact: JsonValue;
  readonly launched: number;
  /**
   * Every gate decision this cohort has already acted on. Durable because it is
   * what makes "the operator has answered" a fact the machine consumes once: a
   * closed wait stays closed, so without it every later step would read the same
   * decision as new.
   *
   * A set, not one slot. A `revise` decision never becomes `accepted`, so two
   * revision rounds leave two decisions that both stay unconsumed forever — and a
   * single slot alternated between them, launching a real session on every pass
   * and never parking again, so the operator could not approve their way out.
   */
  readonly consumed_gate_wait_ids: readonly string[];
}

const isObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contractOf = (value: JsonValue): CompiledStageContract => {
  if (!isObject(value)) throw new Error("stage contract is not an object");
  return value as unknown as CompiledStageContract;
};

const configOf = (contract: CompiledStageContract): DelegatedSessionDefinitionConfig =>
  contract.executor.definition_config as DelegatedSessionDefinitionConfig;

/**
 * The consumed set, reading either shape.
 *
 * The single-slot key is still read so a cohort already in flight when this
 * shipped keeps the decision it had acted on — dropping it would have relaunched
 * that cohort's session once more on the first step after the deploy.
 */
const consumedGateWaitIds = (stored: JsonValue | undefined): readonly string[] => {
  if (!isObject(stored)) return [];
  const many = stored.consumed_gate_wait_ids;
  if (Array.isArray(many)) return many.filter((value): value is string => typeof value === "string");
  return typeof stored.consumed_gate_wait_id === "string" ? [stored.consumed_gate_wait_id] : [];
};

const stageDataOf = (state: CohortStepContext["state"]): SingleRoleCohortStageData => {
  const stored = state.stage_data;
  return {
    unit_id: isObject(stored) && typeof stored.unit_id === "string" ? stored.unit_id : state.cohort_key,
    artifact: isObject(stored) ? readOwn(stored, "artifact") ?? null : null,
    launched: isObject(stored) && hasOwn(stored, "launched") && typeof stored.launched === "number" ? stored.launched : 0,
    consumed_gate_wait_ids: consumedGateWaitIds(stored),
  };
};

const encode = (data: SingleRoleCohortStageData): JsonValue => ({
  unit_id: data.unit_id, artifact: data.artifact, launched: data.launched,
  consumed_gate_wait_ids: [...data.consumed_gate_wait_ids],
});

/** The one role this stage launches, and the reasons it declares for it. */
const roleOf = (contract: CompiledStageContract): { readonly role: string; readonly reasons: ReadonlySet<string> } => {
  const matrix = configOf(contract).prompt_matrix;
  const role = contract.operator_role ?? matrix[0]?.session_role;
  if (!role) throw new Error(`stage '${contract.stage_key}' declares no session role`);
  return { role, reasons: new Set(matrix.filter((entry) => entry.session_role === role).map((entry) => entry.launch_reason)) };
};

interface Projection { readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly outcome: JsonValue | null }
const ACTIVE: Projection = { status: "active", blocked_reason: null, next_actor: "agent", outcome: null };
const GATED: Projection = { status: "blocked", blocked_reason: "gate", next_actor: "operator", outcome: null };
const COMPLETE: Projection = { status: "complete", blocked_reason: null, next_actor: null, outcome: { kind: "succeeded" } };
const LOST: Projection = { status: "blocked", blocked_reason: "retry", next_actor: "operator", outcome: null };

export interface SingleRoleCohortDriverDependencies {
  readonly records: Pick<RunRecordRepository, "load_work_order_capability_seed">;
  load_prompt_bundle(run_id: WorkflowRunId): Promise<readonly PromptBundleEntry[]>;
  readonly stage_type: string;
}

/**
 * The prompt this launch was pinned to.
 *
 * Selected from the run's own bundle, and required to exist: a stage that cannot
 * name the exact cell it declared must not silently launch a session on some
 * other prompt. Falls back to the initial reason only when the stage never
 * declared the revision one — `final_integration` declares one cell and can
 * still be sent back.
 */
const promptFor = (
  bundle: readonly PromptBundleEntry[],
  contract: CompiledStageContract,
  role: string,
  reason: string,
): { readonly reason: string; readonly prompt: { readonly template_path: string; readonly content: string } } => {
  const declared = configOf(contract).prompt_matrix.filter((entry) => entry.session_role === role && entry.launch_reason === reason);
  const chosen = declared[0];
  if (!chosen) throw new Error(`stage '${contract.stage_key}' declares no ${role}:${reason} prompt cell`);
  const cell = bundle.find((entry) => entry.session_role === role && entry.launch_reason === reason
    && entry.template_path === chosen.template_path);
  if (!cell) throw new Error(`run's pinned prompt bundle has no ${role}:${reason} cell for '${chosen.template_path}'`);
  return { reason, prompt: { template_path: cell.template_path, content: cell.content } };
};

export const createSingleRoleCohortDriver = (dependencies: SingleRoleCohortDriverDependencies): CohortMachineDriver => ({
  stage_type: dependencies.stage_type,

  async open_cohorts(input): Promise<readonly OpenCohort[]> {
    const contract = contractOf(input.stage_contract);
    return resolveCohortRoster(contract, input.run_context, input.inputs).map((entry) => ({
      id: cohortIdFor(input.stage_instance_id, entry.cohort_key),
      cohort_key: entry.cohort_key,
      stage_data: encode({ unit_id: entry.cohort_key, artifact: entry.item, launched: 0, consumed_gate_wait_ids: [] }),
    }));
  },

  async step(context: CohortStepContext): Promise<CohortStepDecision | null> {
    const contract = contractOf(context.stage_contract);
    const { role, reasons } = roleOf(contract);
    const stageData = stageDataOf(context.state);
    const dependencyCycle = contract.materialization.kind === "artifact_collections"
      ? selectAcceptedCollectionDependencyCycle(context.state.accepted_outputs) : null;
    if (dependencyCycle) {
      return { event: { change: { status: "failed", blocked_reason: null, next_actor: null,
        outcome: { kind: "failed", code: "roster_failed", detail: dependencyCycle } },
        stage_data: encode(stageData), reopen_output_names: [], effect: { kind: "none" }, launch_reason: "artifact_accepted", actor: "core" }, launch: null };
    }
    if (stageData.launched > 0 && context.state.open_waits.length === 0
      && selectCohortOutputsSatisfied(contract, context, context.state.accepted_outputs)) {
      return { event: { change: COMPLETE, stage_data: encode(stageData), reopen_output_names: [], effect: { kind: "none" },
        launch_reason: "artifact_accepted", actor: "core" }, launch: null };
    }

    const decided = context.state.decided_gates.find((gate) =>
      !stageData.consumed_gate_wait_ids.includes(gate.wait_id) && !gate.accepted);
    if (decided) {
      const disposition = selectArtifactGateDisposition(
        contract.outputs.find((output) => output.name === decided.output_name)?.artifact_type ?? "",
        selectBuiltInGateDisposition(decided.action));
      const consumed = { ...stageData,
        consumed_gate_wait_ids: [...stageData.consumed_gate_wait_ids, decided.wait_id as string] };
      if (disposition === "terminal") {
        return { event: { change: { status: "failed", blocked_reason: null, next_actor: null,
          outcome: { kind: "failed", code: "gate_rejected", detail: `gate '${decided.output_name}' was ended by '${decided.action}'` } },
          stage_data: encode(consumed), reopen_output_names: [], effect: { kind: "none" }, launch_reason: "gate_decided", actor: "core" }, launch: null };
      }
      // A revision: the same role again, under the reason the stage declared for
      // it. The slot is empty — a `revise` decision accepts nothing — so the
      // replacement publishes into it as the next revision of the same chain.
      const reason = reasons.has(REVISION_REASON) ? REVISION_REASON : INITIAL_REASON;
      return launchDecision(context, contract, role, reason, { ...consumed, launched: consumed.launched + 1 }, dependencies, "gate_decided");
    }

    // Parked on its gate: the operator owns the next move.
    if (context.state.open_waits.length > 0) {
      return context.state.status === GATED.status && context.state.blocked_reason === GATED.blocked_reason
        ? null
        : { event: { change: GATED, stage_data: encode(stageData), reopen_output_names: [], effect: { kind: "none" },
          launch_reason: "artifact_accepted", actor: "core" }, launch: null };
    }

    if (context.state.status === "blocked" && context.state.blocked_reason === "retry") return null;
    if (stageData.launched > 0 && context.state.latest_attempt?.ended_at
      && context.state.latest_unfinished_attempt_id === null) {
      return { event: { change: LOST, stage_data: encode(stageData), reopen_output_names: [],
        effect: { kind: "none" }, launch_reason: "retry", actor: "core" }, launch: null };
    }

    if (stageData.launched === 0) {
      return launchDecision(context, contract, role, INITIAL_REASON, { ...stageData, launched: 1 }, dependencies, "initial");
    }
    // Launched, nothing published, no wait: the session owns the next move.
    return null;
  },

  /** A one-role stage takes in no facts from outside the run. */
  apply_event: async (context, event) => {
    if (!isObject(event) || event.kind !== "operator_retry_requested") return null;
    if (context.state.status !== "blocked" || context.state.blocked_reason !== "retry") return null;
    const contract = contractOf(context.stage_contract);
    const { role, reasons } = roleOf(contract);
    const stageData = stageDataOf(context.state);
    const reason = reasons.has("operator_retry") ? "operator_retry" : INITIAL_REASON;
    return launchDecision(context, contract, role, reason, { ...stageData, launched: stageData.launched + 1 }, dependencies, "retry");
  },
});

const launchDecision = async (
  context: CohortStepContext,
  contract: CompiledStageContract,
  role: string,
  reason: string,
  stageData: SingleRoleCohortStageData,
  dependencies: SingleRoleCohortDriverDependencies,
  launch_reason: CohortStepDecision["event"]["launch_reason"],
): Promise<CohortStepDecision> => ({
  event: {
    change: ACTIVE,
    stage_data: encode(stageData),
    reopen_output_names: [],
    effect: { kind: "start_attempt", cohort_id: context.state.cohort_id, attempt_number: context.state.attempt_count + 1 },
    launch_reason, actor: "core",
  },
  launch: {
    attempt_number: context.state.attempt_count + 1,
    adapter_type: contract.executor.executor_type,
    resolve_request: async (attempt_id: AttemptId, launch_transition_id: RunTransitionId) => {
      const bundle = await dependencies.load_prompt_bundle(context.state.run_id);
      const selected = promptFor(bundle, contract, role, reason);
      const session_launch: CommittedSessionLaunch = {
        reason: { transition_id: launch_transition_id, name: selected.reason },
        session_role: role, prompt: selected.prompt, existing_pull_request: null,
      };
      const resolved = await resolveAttemptExecution({
        run_id: context.state.run_id, stage: contract, stage_instance_id: context.state.stage_instance_id,
        unit: { unit_id: context.state.cohort_key as UnitId, parameters: stageData.artifact, depends_on: [] },
        inputs: context.inputs, accepted_cohort_outputs: context.state.accepted_outputs, context: context.run_context,
        outputs: contract.outputs.map((output) => ({ output_name: output.name, artifact_type: output.artifact_type,
          release: output.release, attention: output.attention ?? "none" })),
        identity: `attempt:${attempt_id}`,
        capability_seed: await dependencies.records.load_work_order_capability_seed(),
        session_launch,
        attempt_id: attempt_id as unknown as WorkOrderId,
        attempt_workflow_id: attemptWorkflowId(attempt_id),
      });
      return resolved.request;
    },
  },
});

/**
 * Whether a stage's declared prompt matrix is the build stage's two-role roster.
 *
 * Asked of the *contract* rather than of the stage's name: what decides which
 * machine a cohort runs is how many roles it declares, and a name check would
 * break the moment a definition called its build stage something else.
 */
export const declaresMultipleRoles = (contract: CompiledStageContract): boolean =>
  new Set(configOf(contract).prompt_matrix.map((entry) => entry.session_role)).size > 1;
