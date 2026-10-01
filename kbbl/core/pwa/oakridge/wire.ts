import type {
  CohortPullRequestReconciliation, CohortLifecycleSummary, EpicWorkflowProfile, EpicProfileId,
  FinalPullRequestResponse, ParkedGate, Project, ProjectId, ProjectUpdateError, RepositoryKey, ReviewInbox,
  ReviewInboxItem, RunDetail, RunEventFrame, RunEventOperation, SessionRunLocation,
  StageDetail, StageUnit, WorkflowRunId,
} from "./types";
import type { Result } from "../lib/result";
import { parseRepositoryKey } from "./repository-inputs";

const RUN_EVENT_OPERATIONS: ReadonlySet<string> = new Set<RunEventOperation>([
  "stage_materialized", "materialization_closed", "materialization_failed", "run_cancelled", "unit_admitted",
  "operator_retry_created", "input_revised", "slot_released", "slot_pending", "slot_invalidated", "unit_satisfied",
  "work_started", "gate_opened", "gate_decided", "pull_request_observed", "pull_request_merge_confirmed",
]);

const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isGateRunEventOperation = (operation: string): boolean => operation === "gate_opened" || operation === "gate_decided";
const isPullRequestRunEventOperation = (operation: string): boolean =>
  operation === "pull_request_observed" || operation === "pull_request_merge_confirmed";

const isJsonValue = (value: unknown): value is import("./types").JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
};

const isJsonObject = (value: unknown): value is { readonly [key: string]: import("./types").JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);

/** Parse one server frame without allowing malformed stream data into UI subscribers. */
export const parseOakridgeRunEventFrame = (data: string): RunEventFrame | null => {
  let value: unknown;
  try { value = JSON.parse(data); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Partial<RunEventFrame>;
  if (typeof event.sequence !== "string" || !/^\d+$/.test(event.sequence) || typeof event.operation !== "string"
      || !RUN_EVENT_OPERATIONS.has(event.operation) || typeof event.occurred_at !== "string" || typeof event.replayed !== "boolean") return null;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || typeof payload.run_id !== "string"
      || !nullableString(payload.run_unit_id) || !nullableString(payload.stage_instance_id) || !nullableString(payload.stage_key)
      || !nullableString(payload.unit_id) || !nullableString(payload.work_order_id) || !nullableString(payload.wait_id)
      || !nullableString(payload.output_name) || !nullableString(payload.collection_key) || !nullableString(payload.artifact_revision_id)
      || !(payload.attention === null || payload.attention === "required" || payload.attention === "optional" || payload.attention === "none")
      || !(payload.continuation === null || payload.continuation === "waiting" || payload.continuation === "continuing")
      || !isJsonValue(payload.detail)) return null;
  if (isGateRunEventOperation(event.operation)
      && (payload.run_unit_id === null || payload.stage_instance_id === null || payload.stage_key === null
        || payload.unit_id === null || payload.wait_id === null || payload.output_name === null
        || payload.artifact_revision_id === null || payload.attention === null || payload.continuation === null)) return null;
  if (isPullRequestRunEventOperation(event.operation)) {
    const detail = payload.detail;
    if (payload.run_unit_id === null || payload.stage_instance_id === null || payload.stage_key === null
        || payload.unit_id === null || payload.artifact_revision_id === null || !isJsonObject(detail)
        || typeof detail.repository_key !== "string"
        || typeof detail.pull_request_url !== "string" || typeof detail.state !== "string" || typeof detail.source !== "string"
        || !(detail.merged_at === null || typeof detail.merged_at === "string")) return null;
  }
  return event as RunEventFrame;
};

type RawStageUnit = Omit<StageUnit, "repository_key"> & { repository_key?: string | null };
type RawStageDetail = Omit<StageDetail, "units"> & { units?: RawStageUnit[] };
type RawEpicWorkflowProfile = Omit<EpicWorkflowProfile, "id" | "workflow_run_id" | "repositories"> & {
  id: string;
  workflow_run_id: string;
  repositories: Array<Omit<EpicWorkflowProfile["repositories"][number], "repository_key"> & { repository_key: string }>;
};
export type RawRunDetail = Omit<RunDetail, "stages" | "epic_profile"> & {
  stages: RawStageDetail[];
  epic_profile?: RawEpicWorkflowProfile | null;
};
export type RawParkedGate = Omit<ParkedGate, "repository_key"> & { repository_key?: string | null };
type RawCohortPullRequestReconciliation = Omit<CohortPullRequestReconciliation, "repository_key"> & { repository_key: string };
type RawCohortLifecycleSummary = Omit<CohortLifecycleSummary, "repository_key" | "pull_request_reconciliation"> & {
  repository_key?: string | null;
  pull_request_reconciliation?: RawCohortPullRequestReconciliation | null;
};
type RawReviewInboxItem = Omit<ReviewInboxItem, "repository_key"> & { repository_key?: string | null };
export interface RawReviewInbox {
  cohorts: RawCohortLifecycleSummary[];
  items: RawReviewInboxItem[];
  attention_count: number;
}

export interface ResponseParseError {
  operation: string;
  detail: string;
}

interface RawProject extends Omit<Project, "id"> {
  readonly id: string;
}

const ok = <T>(value: T): Result<T, ResponseParseError> => ({ ok: true, value });
const err = (operation: string, detail: string): Result<never, ResponseParseError> => ({ ok: false, error: { operation, detail } });

export const projectUpdateError = (path: string, detail: string): Result<never, ProjectUpdateError> => ({
  ok: false,
  error: { operation: "update project", path, detail },
});

export const parseProject = (value: unknown): Result<Project, ResponseParseError> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return err("parse project", "response was not an object");
  const project = value as Partial<RawProject>;
  if (typeof project.id !== "string" || !project.id.trim()) return err("parse project", "response contained an empty project id");
  if (typeof project.name !== "string") return err("parse project", "response contained an invalid project name");
  if (typeof project.repo_dir !== "string") return err("parse project", "response contained an invalid repository path");
  if (typeof project.created_at !== "string") return err("parse project", "response contained an invalid creation time");
  if (project.base_branch !== null && project.base_branch !== undefined && typeof project.base_branch !== "string") {
    return err("parse project", "response contained an invalid base branch");
  }
  const forge = project.forge_repository;
  if (forge !== null && forge !== undefined && (typeof forge !== "object" || forge.provider !== "github"
      || typeof forge.owner !== "string" || typeof forge.name !== "string")) {
    return err("parse project", "response contained an invalid forge repository");
  }
  return ok({ ...project, id: project.id as ProjectId } as Project);
};

function parseOptionalRepositoryKey(value: string | null | undefined): Result<RepositoryKey | null | undefined, ResponseParseError> {
  if (value == null) return ok(value);
  const key = parseRepositoryKey(value);
  return key ? ok(key) : err("parse repository key", "response contained an empty repository key");
}

function parseRequiredRepositoryKey(value: string): Result<RepositoryKey, ResponseParseError> {
  const key = parseRepositoryKey(value);
  return key ? ok(key) : err("parse repository key", "response contained an empty repository key");
}

function parseEpicProfile(value: unknown): Result<EpicWorkflowProfile, ResponseParseError> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return err("parse epic profile", "response was not an object");
  const candidate = value as Partial<RawEpicWorkflowProfile>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) return err("parse epic profile", "response contained an empty epic profile id");
  if (typeof candidate.workflow_run_id !== "string" || !candidate.workflow_run_id.trim()) return err("parse epic profile", "response contained an empty workflow run id");
  if (!Array.isArray(candidate.repositories)) return err("parse epic profile", "response contained no repository bindings");
  const profile = candidate as RawEpicWorkflowProfile;
  const repositories = [];
  for (const repository of profile.repositories) {
    if (!repository || typeof repository !== "object" || typeof repository.repository_key !== "string") {
      return err("parse epic profile", "response contained an invalid repository binding");
    }
    const key = parseRequiredRepositoryKey(repository.repository_key);
    if (!key.ok) return key;
    repositories.push({ ...repository, repository_key: key.value });
  }
  return ok({
    ...profile,
    id: profile.id as EpicProfileId,
    workflow_run_id: profile.workflow_run_id as WorkflowRunId,
    repositories,
  });
}

export function parseRunDetail(run: RawRunDetail): Result<RunDetail, ResponseParseError> {
  const stages: StageDetail[] = [];
  for (const stage of run.stages) {
    const units: StageUnit[] = [];
    for (const unit of stage.units ?? []) {
      const repositoryKey = parseOptionalRepositoryKey(unit.repository_key);
      if (!repositoryKey.ok) return repositoryKey;
      units.push({ ...unit, repository_key: repositoryKey.value });
    }
    stages.push({ ...stage, units: stage.units ? units : stage.units });
  }
  const epicProfile = run.epic_profile ? parseEpicProfile(run.epic_profile) : ok(run.epic_profile);
  if (!epicProfile.ok) return epicProfile;
  return ok({
    ...run,
    stages,
    epic_profile: epicProfile.value,
  });
}

export function parseParkedGates(gates: RawParkedGate[]): Result<ParkedGate[], ResponseParseError> {
  const parsed: ParkedGate[] = [];
  for (const gate of gates) {
    const repositoryKey = parseOptionalRepositoryKey(gate.repository_key);
    if (!repositoryKey.ok) return repositoryKey;
    parsed.push({ ...gate, repository_key: repositoryKey.value });
  }
  return ok(parsed);
}

export function parseReviewInbox(inbox: RawReviewInbox): Result<ReviewInbox, ResponseParseError> {
  const cohorts: CohortLifecycleSummary[] = [];
  for (const cohort of inbox.cohorts) {
    const repositoryKey = parseOptionalRepositoryKey(cohort.repository_key);
    if (!repositoryKey.ok) return repositoryKey;
    let reconciliation: CohortPullRequestReconciliation | null | undefined = cohort.pull_request_reconciliation == null
      ? cohort.pull_request_reconciliation
      : undefined;
    if (cohort.pull_request_reconciliation) {
      const reconciliationKey = parseRequiredRepositoryKey(cohort.pull_request_reconciliation.repository_key);
      if (!reconciliationKey.ok) return reconciliationKey;
      reconciliation = { ...cohort.pull_request_reconciliation, repository_key: reconciliationKey.value };
    }
    cohorts.push({ ...cohort, repository_key: repositoryKey.value, pull_request_reconciliation: reconciliation });
  }
  const items: ReviewInboxItem[] = [];
  for (const item of inbox.items) {
    const repositoryKey = parseOptionalRepositoryKey(item.repository_key);
    if (!repositoryKey.ok) return repositoryKey;
    items.push({ ...item, repository_key: repositoryKey.value });
  }
  return ok({ cohorts, items, attention_count: inbox.attention_count });
}

const FINAL_OUTCOMES = new Set(["waiting", "completed", "already_completed", "mismatch", "ignored_stale", "awaiting_external_confirmation"]);

export function parseFinalPullRequestResponse(value: unknown): Result<FinalPullRequestResponse, ResponseParseError> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return err("parse final pull request response", "response was not an object");
  const raw = value as { outcome?: unknown; profile?: unknown };
  if (typeof raw.outcome !== "string" || !FINAL_OUTCOMES.has(raw.outcome)) return err("parse final pull request response", "response contained an unknown outcome");
  if (!raw.profile || typeof raw.profile !== "object" || Array.isArray(raw.profile)) return err("parse final pull request response", "response contained no epic profile");
  const profile = parseEpicProfile(raw.profile);
  if (!profile.ok) return profile;
  return ok({ outcome: raw.outcome, profile: profile.value } as FinalPullRequestResponse);
}

export function parseSessionRunLocation(value: unknown): Result<SessionRunLocation, ResponseParseError> {
  const operation = "parse session run location";
  if (!value || typeof value !== "object" || Array.isArray(value)) return err(operation, "response was not an object");
  const raw = value as Partial<Record<keyof SessionRunLocation, unknown>>;
  if (typeof raw.run_id !== "string" || !raw.run_id) return err(operation, "response contained an empty run id");
  if (typeof raw.stage_instance_id !== "string" || !raw.stage_instance_id) return err(operation, "response contained an empty stage instance id");
  if (typeof raw.stage_key !== "string") return err(operation, "response contained an invalid stage key");
  if (typeof raw.unit_id !== "string") return err(operation, "response contained an invalid unit id");
  if (typeof raw.work_order_id !== "string" || !raw.work_order_id) return err(operation, "response contained an empty work order id");
  return ok({
    run_id: raw.run_id as WorkflowRunId, stage_instance_id: raw.stage_instance_id,
    stage_key: raw.stage_key, unit_id: raw.unit_id, work_order_id: raw.work_order_id,
  });
}
