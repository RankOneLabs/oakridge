import { selectFailureDetail } from "./boundary";

const API = "/oakridge/api";

export async function oakridgeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as unknown;
    throw new Error(selectFailureDetail(body, `oakridge ${path}: ${res.status}`));
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
    throw new Error(selectFailureDetail(b, `oakridge POST ${path}: ${res.status}`));
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as unknown as T;
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
    throw new Error(selectFailureDetail(b, `oakridge PUT ${path}: ${res.status}`));
  }
  return (await res.json()) as T;
}
