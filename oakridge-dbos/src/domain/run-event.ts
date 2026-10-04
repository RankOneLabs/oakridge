import type { V15WorkerKey, V15Change } from "./dev-flow-v15";
import type { CohortId, JsonValue, RunTransitionId, StageInstanceId, WorkflowRunId } from "./primitives";
import type { RunTransitionOperation, TransitionEffectDescriptor, TransitionLaunchReason, TransitionOwner } from "./run-record";

export type OperatorRunEffect =
  | { readonly kind: "none" | "deliver_message" | "resume_wait" }
  | { readonly kind: "start_stage"; readonly stage_instance_id: StageInstanceId }
  | { readonly kind: "worker_decision"; readonly cohort_id: CohortId; readonly from_state: string; readonly to_state: string;
      readonly changes: readonly V15Change[]; readonly actions: readonly { readonly worker: V15WorkerKey; readonly action_point: string }[] }
  | { readonly kind: "cohort_transition"; readonly cohort_id: string; readonly unit_label: string; readonly event_kind: string;
      readonly from_state: string; readonly to_state: string; readonly next_actor: string | null; readonly refusal: null }
  | { readonly kind: "pull_request_observed" | "pull_request_merge_confirmed"; readonly repository_key: string;
      readonly pull_request_url: string; readonly state: string; readonly source: string; readonly merged_at: string | null }
  | { readonly kind: "unrecognized"; readonly effect_kind: string };
export type RawOperatorRunEffect = OperatorRunEffect | TransitionEffectDescriptor;
/** The notification projection of the v15 transition ledger. */
export interface RunEvent {
  readonly sequence: string;
  readonly transition_id: RunTransitionId;
  readonly run_id: WorkflowRunId;
  readonly owner: TransitionOwner;
  readonly launch_reason: TransitionLaunchReason;
  readonly prior_owner_version: number;
  readonly resulting_owner_version: number;
  readonly operation: RunTransitionOperation;
  readonly effect: RawOperatorRunEffect;
  readonly effect_workflow_id: string;
  readonly actor: string;
  readonly occurred_at: string;
}

export interface RunEventRow {
  readonly sequence: string;
  readonly id: string;
  readonly run_id: string;
  readonly owner_kind: TransitionOwner["kind"];
  readonly owner_run_id: string | null;
  readonly owner_stage_instance_id: string | null;
  readonly owner_cohort_id: string | null;
  readonly launch_reason: TransitionLaunchReason;
  readonly prior_owner_version: string;
  readonly resulting_owner_version: string;
  readonly event: JsonValue;
  readonly from_state: string | null;
  readonly to_state: string | null;
  readonly unit_label: string | null;
  readonly target_next_actor: string | null;
  readonly effect_descriptor: JsonValue;
  readonly effect_workflow_id: string;
  readonly actor: string;
  readonly created_at: string;
}

const decodeOwner = (row: RunEventRow): TransitionOwner => {
  if (row.owner_kind === "run" && row.owner_run_id === row.run_id
    && row.owner_stage_instance_id === null && row.owner_cohort_id === null) {
    return { kind: "run", id: row.run_id as WorkflowRunId };
  }
  if (row.owner_kind === "stage_instance" && row.owner_run_id === null
    && row.owner_stage_instance_id !== null && row.owner_cohort_id === null) {
    return { kind: "stage_instance", id: row.owner_stage_instance_id as StageInstanceId };
  }
  if (row.owner_kind === "cohort" && row.owner_run_id === null
    && row.owner_stage_instance_id === null && row.owner_cohort_id !== null) {
    return { kind: "cohort", id: row.owner_cohort_id as CohortId };
  }
  throw new Error(`run event '${row.sequence}' has an invalid owner identity`);
};

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeEffect = (row: RunEventRow): RawOperatorRunEffect => {
  const descriptor = row.effect_descriptor;
  if (isJsonObject(descriptor) && descriptor.kind === "selected_decision") {
    if (!row.owner_cohort_id || !row.from_state || !row.to_state || !Array.isArray(descriptor.changes) || !Array.isArray(descriptor.actions))
      throw new Error(`run event '${row.sequence}' has an invalid selected decision`);
    return { kind: "worker_decision", cohort_id: row.owner_cohort_id as CohortId, from_state: row.from_state, to_state: row.to_state,
      changes: descriptor.changes as unknown as readonly V15Change[],
      actions: descriptor.actions as unknown as readonly { readonly worker: V15WorkerKey; readonly action_point: string }[] };
  }
  if (row.owner_kind === "cohort" && row.owner_cohort_id !== null && row.from_state !== null
    && row.to_state !== null && isJsonObject(row.event) && typeof row.event.kind === "string") {
    return { kind: "cohort_transition", cohort_id: row.owner_cohort_id,
      unit_label: row.unit_label ?? row.owner_cohort_id, event_kind: row.event.kind,
      from_state: row.from_state, to_state: row.to_state,
      next_actor: row.target_next_actor, refusal: null };
  }
  const value = row.effect_descriptor;
  if (!isJsonObject(value)
    || !(Object.prototype.hasOwnProperty.call(value, "kind")) || typeof value.kind !== "string" || value.kind.length === 0) {
    throw new Error(`run event '${row.sequence}' has an invalid effect descriptor`);
  }
  if (value.kind === "start_attempt") throw new Error("retired start_attempt effect cannot be projected");
  return value as RawOperatorRunEffect;
};

export const projectRunEvent = (row: RunEventRow): RunEvent => {
  const effect = decodeEffect(row);
  return {
    sequence: row.sequence,
    transition_id: row.id as RunTransitionId,
    run_id: row.run_id as WorkflowRunId,
    owner: decodeOwner(row),
    launch_reason: row.launch_reason,
    prior_owner_version: Number(row.prior_owner_version),
    resulting_owner_version: Number(row.resulting_owner_version),
    operation: effect.kind,
    effect,
    effect_workflow_id: row.effect_workflow_id,
    actor: row.actor,
    occurred_at: row.created_at,
  };
};
