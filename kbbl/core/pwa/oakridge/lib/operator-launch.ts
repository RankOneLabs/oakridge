import type { OperatorLaunchRequest } from "../operator-contracts";

const PENDING_LAUNCH_KEY = "oakridge:operator:pending-launch";
// Persistence errors propagate to the UI: sending without durable identity is unsafe.
export function readPendingLaunch(): OperatorLaunchRequest | null {
  const raw = localStorage.getItem(PENDING_LAUNCH_KEY);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !("request_id" in parsed) || typeof parsed.request_id !== "string"
    || parsed.request_id.length < 1 || parsed.request_id.length > 200 || !("digest" in parsed)
    || typeof parsed.digest !== "string" || !("input" in parsed)) throw new Error("Stored launch is invalid; cannot safely start another launch.");
  return { request_id: parsed.request_id, digest: parsed.digest, input: parsed.input };
}
export function savePendingLaunch(request: OperatorLaunchRequest): void {
  localStorage.setItem(PENDING_LAUNCH_KEY, JSON.stringify(request));
}
export function clearPendingLaunch(request: OperatorLaunchRequest): void {
  if (readPendingLaunch()?.request_id === request.request_id) localStorage.removeItem(PENDING_LAUNCH_KEY);
}
/** Forgets the retry identity without parsing, so unreadable stored state can still be removed. */
export function discardPendingLaunch(): void {
  localStorage.removeItem(PENDING_LAUNCH_KEY);
}
