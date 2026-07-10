// API client for the oakridge-core proxy at /oakridge/api/*.
// All paths are same-origin relative so the PWA needs no CORS config.

import type {
  OakridgeConfig,
  Project,
  WorkflowDefSummary,
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
} from "./types";

const API = "/oakridge/api";

async function oakridgeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    const detail = typeof body?.error === "string" ? body.error : `oakridge ${path}: ${res.status}`;
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

async function oakridgePost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null) as { error?: string } | null;
    const detail = typeof b?.error === "string" ? b.error : `oakridge POST ${path}: ${res.status}`;
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

async function oakridgePatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null) as { error?: string } | null;
    const detail = typeof b?.error === "string" ? b.error : `oakridge PATCH ${path}: ${res.status}`;
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export async function fetchOakridgeConfig(): Promise<OakridgeConfig> {
  const res = await fetch("/oakridge/config");
  if (!res.ok) return { available: false };
  return (await res.json()) as OakridgeConfig;
}

export function fetchRuns(): Promise<RunSummary[]> {
  return oakridgeGet<RunSummary[]>("/runs");
}

export function fetchRun(id: string): Promise<RunDetail> {
  return oakridgeGet<RunDetail>(`/runs/${encodeURIComponent(id)}`);
}

export function fetchRunGates(runId: string): Promise<ParkedGate[]> {
  return oakridgeGet<ParkedGate[]>(`/runs/${encodeURIComponent(runId)}/gates`);
}

export function fetchGates(): Promise<ParkedGate[]> {
  return oakridgeGet<ParkedGate[]>("/gates");
}

export function fetchArtifact(id: string): Promise<ArtifactDetail> {
  return oakridgeGet<ArtifactDetail>(`/artifact_details/${encodeURIComponent(id)}`);
}

export function resumeGate(gateId: string, req: GateResumeRequest): Promise<GateResumeResponse> {
  return oakridgePost<GateResumeResponse>(`/gates/${encodeURIComponent(gateId)}/resume`, req);
}

export function fetchProjects(): Promise<Project[]> {
  return oakridgeGet<Project[]>("/projects");
}

export function createProject(body: { name: string; repo_dir: string }): Promise<Project> {
  return oakridgePost<Project>("/projects", body);
}

export function fetchWorkflowDefs(): Promise<WorkflowDefSummary[]> {
  return oakridgeGet<WorkflowDefSummary[]>("/workflow_defs");
}

export function createRun(body: CreateRunRequest): Promise<RunSummary> {
  return oakridgePost<RunSummary>("/workflow_runs", body);
}

export function cancelRun(runId: string): Promise<unknown> {
  return oakridgePost<unknown>(`/workflow_runs/${encodeURIComponent(runId)}/cancel`, {});
}

export function retryStuckStage(stageInstanceId: string): Promise<unknown> {
  return oakridgePost<unknown>(`/stage_instances/${encodeURIComponent(stageInstanceId)}/retry_stuck`, {});
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

export function pingThread(threadId: string): Promise<{ ok: boolean }> {
  return oakridgePost(`/threads/${encodeURIComponent(threadId)}/ping`, {});
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
