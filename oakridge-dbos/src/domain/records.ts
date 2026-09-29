/**
 * Look up a key that came from outside — an HTTP path segment, an edge in an
 * uploaded workflow definition, a gate action name — without seeing anything
 * inherited from `Object.prototype`.
 *
 * A plain `record[key]` answers truthily for `constructor`, `toString` and
 * `__proto__` on any object literal, so a membership check written as
 * `if (!record[key])` silently passes for names that are not in the record at
 * all. What follows then reads a `Function` where it expected a domain value:
 * either it crashes on the first property access, or — worse — it proceeds,
 * because the guard that was supposed to stop it has already said yes.
 */
export const readOwn = <Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

/** Whether a key is genuinely present, as opposed to inherited. */
export const hasOwn = (record: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

import type {
  AttemptId,
  CohortId,
  JsonValue,
  ProjectId,
  RunRecordVersion,
  SessionId,
  StageInstanceId,
  WorkflowDefinitionId,
  WorkflowRunId,
} from "./primitives";
import type { WorkflowRunBundlePin } from "./workflow";

/** Shared durable status vocabulary for runs, stages, and cohorts. */
export type CoreStatus = "pending" | "active" | "blocked" | "complete" | "failed" | "cancelled";
export type BlockedReason = "dependency" | "gate" | "capacity" | "external" | "operator" | "retry";
export type NextActor = "core" | "agent" | "service" | "operator" | "external";

export interface ProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  readonly repo_dir: string;
  readonly forge_repository: JsonValue | null;
  readonly integration_branch: string | null;
  readonly created_at: string;
}

export interface WorkflowDefinitionRecord {
  readonly id: WorkflowDefinitionId;
  readonly name: string;
  readonly version: number;
  readonly definition: JsonValue;
  readonly archived: boolean;
  readonly created_at: string;
}

export interface WorkflowRunRecord {
  readonly id: WorkflowRunId;
  readonly workflow_definition_id: WorkflowDefinitionId;
  readonly project_id: ProjectId | null;
  readonly context: JsonValue;
  readonly bundle_pin: WorkflowRunBundlePin;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly outcome: JsonValue | null;
  readonly record_version: RunRecordVersion;
  readonly archived: boolean;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

export interface StageInstanceRecord {
  readonly id: StageInstanceId;
  readonly run_id: WorkflowRunId;
  readonly stage_key: string;
  readonly stage_type: string;
  readonly stage_contract: JsonValue;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly durable_version: number;
  readonly outcome: JsonValue | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

export interface CohortRecord {
  readonly id: CohortId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly cohort_key: string;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly durable_version: number;
  readonly stage_data_version: number;
  /** Versioned, stage-owned data. Core persists it and never interprets it. */
  readonly stage_data: JsonValue;
  readonly outcome: JsonValue | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

export interface AttemptRecord {
  readonly id: AttemptId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly cohort_id: CohortId;
  readonly attempt_number: number;
  readonly status: CoreStatus;
  readonly adapter_type: string;
  readonly request: JsonValue;
  readonly outcome: JsonValue | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

export interface SessionRecord {
  readonly id: SessionId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly attempt_id: AttemptId;
  readonly status: CoreStatus;
  readonly kbbl_session_id: import("./primitives").KbblSessionId | null;
  readonly adapter_reference: JsonValue;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

export interface RuntimeSecretRecord {
  readonly name: string;
  readonly value: string;
  readonly created_at: string;
}
