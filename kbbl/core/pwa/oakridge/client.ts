// API client for the Oakridge backend proxy at /oakridge/api/*.
// All paths are same-origin relative so the PWA needs no CORS config.

import type {
  CohortPullRequestResponse,
  ConfirmCohortMergedRequest,
  OakridgeConfig,
  Project,
  ProjectId,
  ProjectUpdateCommand,
  ProjectUpdateError,
  ProjectWriteInput,
  WorkflowDefSummary,
  WorkflowDefFull,
  WorkflowDefInput,
  CreateRunRequest,
  RunSummary,
  RunDetail,
  ParkedGate,
  ArtifactDetail,
  ArtifactTypeDescriptor,
  GateResumeRequest,
  GateResumeResponse,
  CollabThread,
  ReviewItem,
  PostThreadRequest,
  PostMessageRequest,
  PostAtomEditRequest,
  PostReviewItemRequest,
  PatchReviewItemRequest,
  StageDetail,
  StageUnit,
  ReviewInbox,
  CohortLifecycleSummary,
  ReviewInboxItem,
  CohortPullRequestReconciliation,
  ConfirmFinalPullRequestRequest,
  EpicWorkflowProfile,
  FinalPullRequestResponse,
  RepositoryKey,
  AdmitStageUnitResponse,
  EpicProfileId,
  WorkflowRunId,
  RunSessionAttempt,
  SessionRunLocation,
  WorkOrderReason,
  WorkOrderState,
} from "./types";
import type { Result } from "../lib/result";
import { parseRepositoryKey } from "./repository-inputs";

const API = "/oakridge/api";

type RawStageUnit = Omit<StageUnit, "repository_key"> & { repository_key?: string | null };
type RawStageDetail = Omit<StageDetail, "units"> & { units?: RawStageUnit[] };
type RawEpicWorkflowProfile = Omit<EpicWorkflowProfile, "id" | "workflow_run_id" | "repositories"> & {
  id: string;
  workflow_run_id: string;
  repositories: Array<Omit<EpicWorkflowProfile["repositories"][number], "repository_key"> & { repository_key: string }>;
};
type RawRunDetail = Omit<RunDetail, "stages" | "epic_profile"> & {
  stages: RawStageDetail[];
  epic_profile?: RawEpicWorkflowProfile | null;
};
type RawParkedGate = Omit<ParkedGate, "repository_key"> & { repository_key?: string | null };
type RawCohortPullRequestReconciliation = Omit<CohortPullRequestReconciliation, "repository_key"> & { repository_key: string };
type RawCohortLifecycleSummary = Omit<CohortLifecycleSummary, "repository_key" | "pull_request_reconciliation"> & {
  repository_key?: string | null;
  pull_request_reconciliation?: RawCohortPullRequestReconciliation | null;
};
type RawReviewInboxItem = Omit<ReviewInboxItem, "repository_key"> & { repository_key?: string | null };
interface RawReviewInbox {
  cohorts: RawCohortLifecycleSummary[];
  items: RawReviewInboxItem[];
}

interface ResponseParseError {
  operation: string;
  detail: string;
}

interface RawProject extends Omit<Project, "id"> {
  readonly id: string;
}

const ok = <T>(value: T): Result<T, ResponseParseError> => ({ ok: true, value });
const err = (operation: string, detail: string): Result<never, ResponseParseError> => ({ ok: false, error: { operation, detail } });

const projectUpdateError = (path: string, detail: string): Result<never, ProjectUpdateError> => ({
  ok: false,
  error: { operation: "update project", path, detail },
});

const parseProject = (value: unknown): Result<Project, ResponseParseError> => {
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

function parseRunDetail(run: RawRunDetail): Result<RunDetail, ResponseParseError> {
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

function parseParkedGates(gates: RawParkedGate[]): Result<ParkedGate[], ResponseParseError> {
  const parsed: ParkedGate[] = [];
  for (const gate of gates) {
    const repositoryKey = parseOptionalRepositoryKey(gate.repository_key);
    if (!repositoryKey.ok) return repositoryKey;
    parsed.push({ ...gate, repository_key: repositoryKey.value });
  }
  return ok(parsed);
}

function parseReviewInbox(inbox: RawReviewInbox): Result<ReviewInbox, ResponseParseError> {
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
  return ok({ cohorts, items });
}

const FINAL_OUTCOMES = new Set(["waiting", "completed", "already_completed", "mismatch", "ignored_stale", "awaiting_external_confirmation"]);

function parseFinalPullRequestResponse(value: unknown): Result<FinalPullRequestResponse, ResponseParseError> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return err("parse final pull request response", "response was not an object");
  const raw = value as { outcome?: unknown; profile?: unknown };
  if (typeof raw.outcome !== "string" || !FINAL_OUTCOMES.has(raw.outcome)) return err("parse final pull request response", "response contained an unknown outcome");
  if (!raw.profile || typeof raw.profile !== "object" || Array.isArray(raw.profile)) return err("parse final pull request response", "response contained no epic profile");
  const profile = parseEpicProfile(raw.profile);
  if (!profile.ok) return profile;
  return ok({ outcome: raw.outcome, profile: profile.value } as FinalPullRequestResponse);
}

const WORK_ORDER_REASONS = new Set<string>(["initial", "operator_retry", "input_revision"]);
const WORK_ORDER_STATES = new Set<string>(["available", "started", "completed", "abandoned"]);

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

/**
 * One attempt from `GET /runs/:id/sessions`, checked field by field.
 *
 * The union members are validated against the sets above rather than cast,
 * because they are the sidebar's attempt label and its state badge: a value the
 * backend grew that this build does not know about must surface as a parse
 * failure naming the field, not render as a blank chip.
 */
function parseRunSessionAttempt(value: unknown): Result<RunSessionAttempt, ResponseParseError> {
  const operation = "parse run session attempt";
  if (!value || typeof value !== "object" || Array.isArray(value)) return err(operation, "entry was not an object");
  const raw = value as Partial<Record<keyof RunSessionAttempt, unknown>>;
  if (typeof raw.work_order_id !== "string" || !raw.work_order_id) return err(operation, "entry contained an empty work order id");
  if (typeof raw.session_id !== "string" || !raw.session_id) return err(operation, "entry contained an empty session id");
  if (typeof raw.stage_instance_id !== "string" || !raw.stage_instance_id) return err(operation, "entry contained an empty stage instance id");
  if (typeof raw.stage_key !== "string") return err(operation, "entry contained an invalid stage key");
  if (typeof raw.unit_id !== "string") return err(operation, "entry contained an invalid unit id");
  if (typeof raw.reason !== "string" || !WORK_ORDER_REASONS.has(raw.reason)) return err(operation, "entry contained an unknown work order reason");
  if (typeof raw.work_order_state !== "string" || !WORK_ORDER_STATES.has(raw.work_order_state)) return err(operation, "entry contained an unknown work order state");
  if (typeof raw.created_at !== "string") return err(operation, "entry contained an invalid creation time");
  if (!isNullableString(raw.completed_at)) return err(operation, "entry contained an invalid completion time");
  if (!isNullableString(raw.executor_health_kind)) return err(operation, "entry contained an invalid executor health kind");
  if (typeof raw.cleanup_state !== "string") return err(operation, "entry contained an invalid cleanup state");
  return ok({
    work_order_id: raw.work_order_id, session_id: raw.session_id, stage_instance_id: raw.stage_instance_id,
    stage_key: raw.stage_key, unit_id: raw.unit_id, reason: raw.reason as WorkOrderReason,
    work_order_state: raw.work_order_state as WorkOrderState, created_at: raw.created_at,
    completed_at: raw.completed_at, executor_health_kind: raw.executor_health_kind, cleanup_state: raw.cleanup_state,
  });
}

function parseRunSessionAttempts(value: unknown): Result<RunSessionAttempt[], ResponseParseError> {
  if (!Array.isArray(value)) return err("parse run sessions", "response was not an array");
  const attempts: RunSessionAttempt[] = [];
  for (const entry of value) {
    const attempt = parseRunSessionAttempt(entry);
    if (!attempt.ok) return attempt;
    attempts.push(attempt.value);
  }
  return ok(attempts);
}

function parseSessionRunLocation(value: unknown): Result<SessionRunLocation, ResponseParseError> {
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

function unwrapResponse<T>(path: string, result: Result<T, ResponseParseError>): T {
  if (result.ok) return result.value;
  throw new Error(`oakridge ${path}: ${result.error.operation}: ${result.error.detail}`);
}

/**
 * The reason a request failed, in whichever field the route used to say it.
 *
 * Most routes answer `{ error }`, but the typed domain results answer
 * `{ kind, detail }` — a refused run delete says
 * `{ kind: "active_conflict", detail: "run has an active DBOS workflow attempt" }`.
 * Reading only `error` threw that away and showed a bare status code, so a
 * delete that the server had explained precisely looked to the operator like it
 * was simply broken.
 */
export function selectFailureDetail(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const candidate = body as { readonly error?: unknown; readonly detail?: unknown; readonly kind?: unknown };
  if (typeof candidate.error === "string" && candidate.error.length > 0) return candidate.error;
  if (typeof candidate.detail === "string" && candidate.detail.length > 0) return candidate.detail;
  if (typeof candidate.kind === "string" && candidate.kind.length > 0) return candidate.kind;
  return fallback;
}

async function oakridgeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as unknown;
    const detail = selectFailureDetail(body, `oakridge ${path}: ${res.status}`);
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

interface OakridgePostOptions { readonly idempotency_key?: string }

async function oakridgePost<T>(path: string, body: unknown, options: OakridgePostOptions = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.idempotency_key ? { "Idempotency-Key": options.idempotency_key } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null) as unknown;
    const detail = selectFailureDetail(b, `oakridge POST ${path}: ${res.status}`);
    throw new Error(detail);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as unknown as T;
  }
  return (await res.json()) as T;
}

interface OakridgePutOptions { readonly idempotency_key: string }

/** A bodiless, idempotent PUT — the shape of oakridge's operator commands (retry). */
async function oakridgePut<T>(path: string, options: OakridgePutOptions): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "PUT",
    headers: { "Idempotency-Key": options.idempotency_key },
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null) as unknown;
    const detail = selectFailureDetail(b, `oakridge PUT ${path}: ${res.status}`);
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

async function oakridgeDelete(path: string): Promise<void> {
  const res = await fetch(`${API}${path}`, { method: "DELETE" });
  if (!res.ok) {
    const b = await res.json().catch(() => null) as unknown;
    const detail = selectFailureDetail(b, `oakridge DELETE ${path}: ${res.status}`);
    throw new Error(detail);
  }
}

async function oakridgePatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null) as unknown;
    const detail = selectFailureDetail(b, `oakridge PATCH ${path}: ${res.status}`);
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export async function fetchOakridgeConfig(): Promise<OakridgeConfig> {
  const res = await fetch("/oakridge/config");
  if (!res.ok) return { available: false };
  return (await res.json()) as OakridgeConfig;
}

export function fetchRuns(filter?: string): Promise<RunSummary[]> {
  const qs = filter ? `?filter=${encodeURIComponent(filter)}` : "";
  return oakridgeGet<RunSummary[]>(`/runs${qs}`);
}

export function fetchRun(id: string): Promise<RunDetail> {
  const path = `/runs/${encodeURIComponent(id)}`;
  return oakridgeGet<RawRunDetail>(path).then((value) => unwrapResponse(path, parseRunDetail(value)));
}

export function fetchRunGates(runId: string): Promise<ParkedGate[]> {
  const path = `/runs/${encodeURIComponent(runId)}/gates`;
  return oakridgeGet<RawParkedGate[]>(path).then((value) => unwrapResponse(path, parseParkedGates(value)));
}

/**
 * Every agent session the run has opened, oldest first — one entry per work
 * order that has one, so a retried unit lists each attempt rather than only its
 * live one. An unknown run id answers `[]`, matching `/runs/:id/gates`.
 */
export function fetchRunSessions(runId: string): Promise<RunSessionAttempt[]> {
  const path = `/runs/${encodeURIComponent(runId)}/sessions`;
  return oakridgeGet<unknown>(path).then((value) => unwrapResponse(path, parseRunSessionAttempts(value)));
}

/**
 * The run a session belongs to, or null when it belongs to none.
 *
 * The route answers 404 for "no run" so a caller can tell it from "not one of
 * ours"; that is a routine answer here, not a failure, so it becomes `null`
 * rather than a thrown error. Every other non-OK status still throws.
 */
export async function fetchSessionRun(sessionId: string): Promise<SessionRunLocation | null> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/run`;
  const res = await fetch(`${API}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => null) as unknown;
    throw new Error(selectFailureDetail(body, `oakridge ${path}: ${res.status}`));
  }
  return unwrapResponse(path, parseSessionRunLocation(await res.json()));
}

export function fetchGates(): Promise<ParkedGate[]> {
  return oakridgeGet<RawParkedGate[]>("/gates").then((value) => unwrapResponse("/gates", parseParkedGates(value)));
}

export function fetchReviewInbox(): Promise<ReviewInbox> {
  return oakridgeGet<RawReviewInbox>("/review_inbox").then((value) => unwrapResponse("/review_inbox", parseReviewInbox(value)));
}

export function admitStageUnit(stageId: string, unitId: string, idempotencyKey: string): Promise<AdmitStageUnitResponse> {
  return oakridgePost(`/stages/${encodeURIComponent(stageId)}/units/${encodeURIComponent(unitId)}/admit`, { idempotency_key: idempotencyKey });
}

export function fetchArtifact(id: string): Promise<ArtifactDetail> {
  return oakridgeGet<ArtifactDetail>(`/artifact_details/${encodeURIComponent(id)}`);
}

export function resumeGate(gateId: string, req: GateResumeRequest): Promise<GateResumeResponse> {
  return oakridgePost<GateResumeResponse>(`/gates/${encodeURIComponent(gateId)}/resume`, req);
}

/**
 * Confirms a cohort's pull request merged, when Oakridge cannot see the
 * repository for itself.
 *
 * This is the fallback behind the GitHub poller, not a second path: the backend
 * checks a confirmation against the same expectations it checks a polled
 * observation against, so this asserts only that the merge happened.
 */
export function confirmCohortMerged(cohortId: string, req: ConfirmCohortMergedRequest): Promise<CohortPullRequestResponse> {
  return oakridgePost<CohortPullRequestResponse>(`/cohorts/${encodeURIComponent(cohortId)}/pull_request`, { kind: "operator_confirmation", ...req });
}

export function fetchProjects(): Promise<Project[]> {
  return oakridgeGet<Project[]>("/projects");
}

export function createProject(body: ProjectWriteInput): Promise<Project> {
  return oakridgePost<Project>("/projects", body);
}

export async function updateProject(command: ProjectUpdateCommand): Promise<Result<Project, ProjectUpdateError>> {
  const path = `/projects/${encodeURIComponent(command.id)}`;
  try {
    const response = await fetch(`${API}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command.project),
    });
    if (!response.ok) {
      const responseBody = await response.json().catch(() => null) as unknown;
      return projectUpdateError(path, selectFailureDetail(responseBody, `oakridge PUT ${path}: ${response.status}`));
    }
    const parsed = parseProject(await response.json());
    return parsed.ok ? parsed : projectUpdateError(path, `${parsed.error.operation}: ${parsed.error.detail}`);
  } catch (error) {
    return projectUpdateError(path, error instanceof Error ? error.message : "request failed");
  }
}

// Retired defs are hidden by default: the seed archives superseded built-ins, so
// without the filter the launcher accumulates every version ever shipped.
export function fetchWorkflowDefs(includeArchived = false): Promise<WorkflowDefSummary[]> {
  const query = includeArchived ? "?include_archived=1" : "";
  return oakridgeGet<WorkflowDefSummary[]>(`/workflow_defs${query}`);
}

export function archiveWorkflowDef(defId: string): Promise<unknown> {
  return oakridgePost<unknown>(`/workflow_defs/${encodeURIComponent(defId)}/archive`, {});
}

export function unarchiveWorkflowDef(defId: string): Promise<unknown> {
  return oakridgePost<unknown>(`/workflow_defs/${encodeURIComponent(defId)}/unarchive`, {});
}

export function fetchWorkflowDef(id: string): Promise<WorkflowDefFull> {
  return oakridgeGet<WorkflowDefFull>(`/workflow_defs/${encodeURIComponent(id)}`);
}

export function createWorkflowDef(body: WorkflowDefInput): Promise<WorkflowDefFull> {
  return oakridgePost<WorkflowDefFull>("/workflow_defs", body);
}

export function createRun(body: CreateRunRequest, idempotencyKey: string): Promise<RunSummary> {
  return oakridgePost<RunSummary>("/workflow_runs", body, { idempotency_key: idempotencyKey });
}

export function cancelRun(runId: string): Promise<unknown> {
  return oakridgePost<unknown>(`/workflow_runs/${encodeURIComponent(runId)}/cancel`, {});
}

export function archiveRun(runId: string): Promise<unknown> {
  return oakridgePost<unknown>(`/workflow_runs/${encodeURIComponent(runId)}/archive`, {});
}

export function unarchiveRun(runId: string): Promise<unknown> {
  return oakridgePost<unknown>(`/workflow_runs/${encodeURIComponent(runId)}/unarchive`, {});
}

export function deleteRun(runId: string): Promise<void> {
  return oakridgeDelete(`/workflow_runs/${encodeURIComponent(runId)}`);
}

/**
 * Operator retry of one run unit — the recovery for a rejected output or a
 * dead executor. Oakridge keys the request on `Idempotency-Key`; a fresh key
 * per click is a fresh decision, and a repeat of the same key returns the
 * work order it already created.
 */
export function retryRunUnit(stageInstanceId: string, unitId: string): Promise<unknown> {
  return oakridgePut<unknown>(
    `/stage_instances/${encodeURIComponent(stageInstanceId)}/units/${encodeURIComponent(unitId)}/retry`,
    { idempotency_key: crypto.randomUUID() },
  );
}

export function confirmFinalPullRequest(
  runId: string,
  repositoryKey: RepositoryKey,
  request: ConfirmFinalPullRequestRequest,
): Promise<FinalPullRequestResponse> {
  const path = `/workflow_runs/${encodeURIComponent(runId)}/final_pull_requests/${encodeURIComponent(repositoryKey)}/confirm`;
  return oakridgePost<unknown>(
    path,
    request,
  ).then((value) => unwrapResponse(path, parseFinalPullRequestResponse(value)));
}

export function fetchArtifactTypes(): Promise<ArtifactTypeDescriptor[]> {
  return oakridgeGet<ArtifactTypeDescriptor[]>("/artifact_types");
}

// ── Collab: threads ───────────────────────────────────────────────────────────

export function fetchThreads(artifactId: string): Promise<CollabThread[]> {
  return oakridgeGet<CollabThread[]>(`/artifacts/${encodeURIComponent(artifactId)}/threads`);
}

export function postThread(
  artifactId: string,
  req: PostThreadRequest,
): Promise<{ thread_id: string; message_id: string }> {
  return oakridgePost(`/artifacts/${encodeURIComponent(artifactId)}/threads`, req);
}

export function postMessage(
  threadId: string,
  req: PostMessageRequest,
): Promise<{ message_id: string }> {
  return oakridgePost(`/threads/${encodeURIComponent(threadId)}/messages`, req);
}

export function pingThread(threadId: string, idempotencyKey: string): Promise<{ ok: boolean }> {
  return oakridgePost(`/threads/${encodeURIComponent(threadId)}/ping`, {}, { idempotency_key: idempotencyKey });
}

export function resolveThread(threadId: string): Promise<{ thread_id: string; status: string }> {
  return oakridgePatch(`/threads/${encodeURIComponent(threadId)}`, { status: "resolved" });
}

// ── Collab: atom edits ────────────────────────────────────────────────────────

export function postAtomEdit(
  artifactId: string,
  req: PostAtomEditRequest,
): Promise<{ artifact_id: string }> {
  return oakridgePost(`/artifacts/${encodeURIComponent(artifactId)}/edits`, req);
}

// ── Collab: review items ──────────────────────────────────────────────────────

export function fetchReviewItems(artifactId: string): Promise<ReviewItem[]> {
  return oakridgeGet<ReviewItem[]>(`/artifacts/${encodeURIComponent(artifactId)}/review_items`);
}

export function postReviewItem(
  artifactId: string,
  req: PostReviewItemRequest,
): Promise<ReviewItem> {
  return oakridgePost(`/artifacts/${encodeURIComponent(artifactId)}/review_items`, req);
}

export function patchReviewItem(
  reviewItemId: string,
  req: PatchReviewItemRequest,
): Promise<ReviewItem> {
  return oakridgePatch(`/review_items/${encodeURIComponent(reviewItemId)}`, req);
}
