// API client for the Oakridge backend proxy at /oakridge/api/*.
// All paths are same-origin relative so the PWA needs no CORS config.

import type {
  CohortPullRequestResponse,
  OakridgeConfig,
  Project,
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
  CollabThread,
  PostThreadRequest,
  PostMessageRequest,
  PostSessionMessageRequest,
  SessionMessageAccepted,
  SessionMessageRecord,
  PostAtomEditRequest,
  ReviewInbox,
  SessionRunLocation,
  RunDiagnosis,
} from "./types";
import type { Result } from "../lib/result";

const API = "/oakridge/api";

import { parseProject, parseRunDetail, parseRunDiagnosis, parseParkedGates, parseReviewInbox, parseSessionRunLocation, parseSessionMessageRecord, parseSessionMessageAccepted, type ResponseParseError, type RawRunDetail, type RawParkedGate, type RawReviewInbox } from "./wire";

const projectUpdateError = (path: string, detail: string): Result<never, ProjectUpdateError> => ({
  ok: false,
  error: { operation: "update project", path, detail },
});

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

/** A received HTTP failure, distinct from a request with an unknown delivery outcome. */
export class OakridgeHttpError extends Error {
  constructor(readonly status: number, detail: string) { super(detail); this.name = "OakridgeHttpError"; }
}

/** Cohort routes reject invalid requests with 4xx; 5xx may follow a committed request. */
export function selectIsDefinitiveRequestFailure(error: unknown): boolean {
  return error instanceof OakridgeHttpError && error.status >= 400 && error.status < 500;
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
    throw new OakridgeHttpError(res.status, detail);
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

export function fetchRunDiagnosis(id: string): Promise<RunDiagnosis> {
  const path = `/runs/${encodeURIComponent(id)}/diagnosis`;
  return oakridgeGet<unknown>(path).then(parseRunDiagnosis);
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

export function fetchArtifact(id: string): Promise<ArtifactDetail> {
  return oakridgeGet<ArtifactDetail>(`/artifact_details/${encodeURIComponent(id)}`);
}



/**
 * Confirms a cohort's pull request merged, when Oakridge cannot see the
 * repository for itself.
 *
 * This is the fallback behind the GitHub poller, not a second path: the backend
 * checks a confirmation against the same expectations it checks a polled
 * observation against, so this asserts only that the merge happened.
 */
export function confirmCohortMerged(cohortId: string): Promise<CohortPullRequestResponse> {
  return oakridgePost<CohortPullRequestResponse>(`/cohorts/${encodeURIComponent(cohortId)}/pull_request/refresh`, {});
}

export function fetchProjects(): Promise<Project[]> {
  return oakridgeGet<unknown>("/projects").then((body) => {
    if (!Array.isArray(body)) throw new Error("oakridge /projects: response was not a list");
    return body.map((value) => unwrapResponse("/projects", parseProject(value)));
  });
}

export function createProject(body: ProjectWriteInput): Promise<Project> {
  return oakridgePost<unknown>("/projects", body).then((value) => unwrapResponse("/projects", parseProject(value)));
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

export function submitCohortRequest(input: { readonly cohort_id: string; readonly expected_version: number;
  readonly request: import("../../../../oakridge-dbos/src/domain/dev-flow-v15").V15OperatorRequest; readonly id: string }): Promise<unknown> {
  return oakridgePost(`/cohorts/${encodeURIComponent(input.cohort_id)}/requests`, {
    id: input.id, expected_version: input.expected_version, request: input.request,
  });
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

export function fetchSessionMessages(runId: string, cohortId?: string): Promise<SessionMessageRecord[]> {
  const query = cohortId ? `?cohort_id=${encodeURIComponent(cohortId)}` : "";
  return oakridgeGet<unknown>(`/runs/${encodeURIComponent(runId)}/messages${query}`).then((body) => {
    if (!Array.isArray(body)) throw new Error("oakridge session messages: response was not a list");
    return body.map(parseSessionMessageRecord);
  });
}

export function fetchSessionMessageDelivery(runId: string, deliveryKey: string): Promise<SessionMessageRecord> {
  return oakridgeGet<unknown>(`/runs/${encodeURIComponent(runId)}/messages/${encodeURIComponent(deliveryKey)}`).then(parseSessionMessageRecord);
}

export function postSessionMessage(runId: string, deliveryKey: string, request: PostSessionMessageRequest): Promise<SessionMessageAccepted> {
  return oakridgePost<unknown>(`/runs/${encodeURIComponent(runId)}/messages`, request, { idempotency_key: deliveryKey }).then(parseSessionMessageAccepted);
}

// ── Collab: atom edits ────────────────────────────────────────────────────────

export function postAtomEdit(
  artifactId: string,
  req: PostAtomEditRequest,
): Promise<{ artifact_id: string }> {
  return oakridgePost(`/artifacts/${encodeURIComponent(artifactId)}/edits`, req);
}
