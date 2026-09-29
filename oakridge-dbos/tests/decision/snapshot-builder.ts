import type { CoreStatus } from "../../src/domain/records";
import type { ArtifactId, CohortId, JsonValue, RunRecordVersion, StageInstanceId, WorkflowRunId } from "../../src/domain/primitives";
import type { CohortSnapshot, RunSnapshot, StageSnapshot } from "../../src/decision/snapshot";

export const RUN_ID = "00000000-0000-4000-8000-000000000001" as WorkflowRunId;

export const artifactId = (suffix: number): ArtifactId =>
  `00000000-0000-4000-8001-${String(suffix).padStart(12, "0")}` as ArtifactId;

export const stageId = (suffix: number): StageInstanceId =>
  `00000000-0000-4000-8002-${String(suffix).padStart(12, "0")}` as StageInstanceId;

export const cohortId = (suffix: number): CohortId =>
  `00000000-0000-4000-8003-${String(suffix).padStart(12, "0")}` as CohortId;

export const cohort = (suffix: number, options: {
  readonly status?: CoreStatus;
  readonly durable_version?: number;
  readonly accepted_artifact_ids?: readonly ArtifactId[];
  readonly outcome?: JsonValue | null;
} = {}): CohortSnapshot => ({
  id: cohortId(suffix),
  status: options.status ?? "active",
  blocked_reason: null,
  next_actor: options.status === "complete" ? null : "agent",
  durable_version: options.durable_version ?? 0,
  accepted_artifact_ids: options.accepted_artifact_ids ?? [],
  outcome: options.outcome ?? null,
});

export const stage = (suffix: number, options: {
  readonly status?: CoreStatus;
  readonly durable_version?: number;
  readonly dependencies?: readonly StageInstanceId[];
  readonly accepted_artifact_ids?: readonly ArtifactId[];
  readonly cohorts?: readonly CohortSnapshot[];
  readonly outcome?: JsonValue | null;
} = {}): StageSnapshot => ({
  id: stageId(suffix),
  status: options.status ?? "pending",
  blocked_reason: null,
  next_actor: options.status === "complete" ? null : "core",
  durable_version: options.durable_version ?? 0,
  dependency_stage_instance_ids: options.dependencies ?? [],
  accepted_artifact_ids: options.accepted_artifact_ids ?? [],
  cohorts: options.cohorts ?? [],
  outcome: options.outcome ?? null,
});

export const snapshot = (stages: readonly StageSnapshot[], options: {
  readonly status?: CoreStatus;
  readonly record_version?: number;
} = {}): RunSnapshot => ({
  run: {
    id: RUN_ID,
    status: options.status ?? "active",
    record_version: (options.record_version ?? 0) as RunRecordVersion,
    outcome: null,
  },
  stages,
});
