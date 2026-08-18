// API client for the Oakridge backend proxy at /oakridge/api/*.
// All paths are same-origin relative so the PWA needs no CORS config.

import type {
  CohortPullRequestResponse,
  ConfirmCohortMergedRequest,
  OakridgeConfig,
  Project,
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
} from "./types";
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

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface ResponseParseError {
  operation: string;
  detail: string;
}

const ok = <T>(value: T): Result<T, ResponseParseError> => ({ ok: true, value });
const err = (operation: string, detail: string): Result<never, ResponseParseError> => ({ ok: false, error: { operation, detail } });

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

export function createProject(body: { name: string; repo_dir: string }): Promise<Project> {
  return oakridgePost<Project>("/projects", body);
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

export function retryStuckStage(stageInstanceId: string, unitId?: string): Promise<unknown> {
  return oakridgePost<unknown>(`/stage_instances/${encodeURIComponent(stageInstanceId)}/retry_stuck`, {
    unit_id: unitId,
  });
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
