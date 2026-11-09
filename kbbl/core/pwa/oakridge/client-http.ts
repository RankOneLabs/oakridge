// HTTP primitives for the Oakridge backend proxy at /oakridge/api/*.
// All paths are same-origin relative so the PWA needs no CORS config.

import { selectFailureDetail } from "./adapters/boundary";
import type { OperatorIngressResponse } from "./operator-contracts/http/ingress";

export const API = "/oakridge/api";
export const OPERATOR = "/api";
export const runPath = (runId: string): string => `${OPERATOR}/runs/${encodeURIComponent(runId)}`;
export const unitPath = (runId: string, unitId: string): string => `${runPath(runId)}/units/${encodeURIComponent(unitId)}`;

export function committed(response: OperatorIngressResponse, path: string): string {
  if (response.kind === "committed") return response.run_id;
  throw new Error(`oakridge ${path}: unexpected ingress response`);
}

export async function oakridgeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as unknown;
    const detail = selectFailureDetail(body, `oakridge ${path}: ${res.status}`);
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

interface OakridgePostOptions { readonly idempotency_key?: string }

export async function oakridgePost<T>(path: string, body: unknown, options: OakridgePostOptions = {}): Promise<T> {
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

export async function oakridgePutBody<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Oakridge-Publisher": "operator" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null) as unknown;
    const detail = selectFailureDetail(b, `oakridge PUT ${path}: ${res.status}`);
    throw new Error(detail);
  }
  return (await res.json()) as T;
}
