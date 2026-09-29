import type { CohortId, JsonValue, RunTransitionId, StageInstanceId, WorkflowRunId } from "./primitives";
import type { RunTransitionOperation, TransitionEffectDescriptor, TransitionLaunchReason, TransitionOwner } from "./run-record";

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
  readonly effect: TransitionEffectDescriptor;
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

const decodeEffect = (row: RunEventRow): TransitionEffectDescriptor => {
  const value = row.effect_descriptor;
  if (!isJsonObject(value)
    || !(Object.prototype.hasOwnProperty.call(value, "kind")) || typeof value.kind !== "string" || value.kind.length === 0) {
    throw new Error(`run event '${row.sequence}' has an invalid effect descriptor`);
  }
  return value as TransitionEffectDescriptor;
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
