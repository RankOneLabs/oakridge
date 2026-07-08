// API client for the oakridge-core proxy at /oakridge/api/*.
// All paths are same-origin relative so the PWA needs no CORS config.

import type {
  OakridgeConfig,
  RunSummary,
  RunDetail,
  ParkedGate,
  ArtifactDetail,
  GateResumeRequest,
  GateResumeResponse,
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
