import type { WorkerResult } from "../core-client/core-types";
import type { ExternalHandle, ProviderResult, TerminalObservation } from "./provider";
import { INPUT_CONTRACTS } from "./provider-catalog";

/** Provider calls are bounded here; the step that runs them never hangs the workflow. */
export function bounded<Value>(operation: Promise<ProviderResult<Value>>, timeout_ms: number, controller: AbortController): Promise<ProviderResult<Value>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { controller.abort(new Error("provider deadline exceeded")); resolve({ kind: "uncertain", detail: `provider did not respond within ${timeout_ms}ms` }); }, timeout_ms);
    operation.then((result) => { clearTimeout(timer); resolve(result); }, (error) => { clearTimeout(timer); resolve({ kind: "uncertain", detail: String(error) }); });
  });
}

/** Why an attempt failed, as WorkerEnded reports it. */
export type WorkerFailure = Extract<WorkerResult, { readonly kind: "failed" }>;
const failed = (code: string, detail: string): WorkerFailure => ({ kind: "failed", code, detail });

function isWorkerResult(value: unknown): value is WorkerResult {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  if (value.kind === "succeeded") return true;
  return value.kind === "failed" && "code" in value && typeof value.code === "string" && "detail" in value && typeof value.detail === "string";
}
export function isExternalHandle(value: unknown): value is ExternalHandle {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  if (value.kind === INPUT_CONTRACTS.session) return "session_id" in value && typeof value.session_id === "string";
  return value.kind === "completed" && "result" in value && isWorkerResult(value.result);
}

/** What one start attempt taught us: a started execution, a definite refusal, or try again. */
export type StartOutcome =
  | { readonly kind: "started"; readonly handle: ExternalHandle }
  | { readonly kind: "refused"; readonly failure: WorkerFailure }
  | { readonly kind: "retry"; readonly detail: string };
export function resolveStart(result: ProviderResult<unknown>): StartOutcome {
  switch (result.kind) {
    case "acknowledged": return isExternalHandle(result.value) ? { kind: "started", handle: result.value }
      : { kind: "retry", detail: "provider acknowledged a start without a valid handle" };
    case "permanently_rejected": return { kind: "refused", failure: failed(result.code, result.detail) };
    case "transiently_unavailable": case "uncertain": return { kind: "retry", detail: result.detail };
  }
}

export type ObserveOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "ended"; readonly result: WorkerResult }
  | { readonly kind: "refused"; readonly failure: WorkerFailure }
  | { readonly kind: "retry"; readonly detail: string; readonly is_unavailable: boolean };
export function resolveObserve(result: ProviderResult<TerminalObservation | unknown>): ObserveOutcome {
  if (result.kind === "acknowledged") {
    const value = result.value;
    if (value && typeof value === "object" && "kind" in value && value.kind === "running") return { kind: "running" };
    if (value && typeof value === "object" && "kind" in value && value.kind === "terminal" && "result" in value && isWorkerResult(value.result))
      return { kind: "ended", result: value.result };
    // A malformed terminal observation cannot end an attempt.
    return { kind: "refused", failure: failed("observation_rejected", "provider returned a malformed terminal observation") };
  }
  if (result.kind === "permanently_rejected") return { kind: "refused", failure: failed(result.code, result.detail) };
  return { kind: "retry", detail: result.detail, is_unavailable: result.kind === "transiently_unavailable" };
}

export type StopOutcome = { readonly kind: "confirmed" } | { readonly kind: "retry"; readonly detail: string };
/** Only a positive acknowledgement proves termination. */
export function resolveStop(result: ProviderResult<unknown>): StopOutcome {
  if (result.kind === "acknowledged") return result.value && typeof result.value === "object" && "stopped" in result.value && result.value.stopped === true
    ? { kind: "confirmed" } : { kind: "retry", detail: "provider returned a malformed stop acknowledgement" };
  return { kind: "retry", detail: result.kind === "permanently_rejected" ? `${result.code}: ${result.detail}` : result.detail };
}
