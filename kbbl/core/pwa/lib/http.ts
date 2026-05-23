export async function responseError(res: Response, label = "request"): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const detail = typeof body?.error === "string" ? body.error : `${label} failed: ${res.status}`;
  return new Error(detail);
}

export async function ensureOk(res: Response, label = "request"): Promise<void> {
  if (!res.ok) throw await responseError(res, label);
}
