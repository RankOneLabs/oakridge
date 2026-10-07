import { decodeCoreResponse, type CheckedValue, type Trigger } from "../core-client/generated-contracts";
import type { EffectPayload } from "./intents";
import type { ExternalHandle, ProviderResult, TerminalObservation } from "./provider";

/** Provider calls are bounded here; the step that runs them never hangs the workflow. */
export function bounded<Value>(operation: Promise<ProviderResult<Value>>, timeout_ms: number, controller: AbortController): Promise<ProviderResult<Value>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { controller.abort(new Error("provider deadline exceeded")); resolve({ kind: "uncertain", detail: `provider did not respond within ${timeout_ms}ms` }); }, timeout_ms);
    operation.then((result) => { clearTimeout(timer); resolve(result); }, (error) => { clearTimeout(timer); resolve({ kind: "uncertain", detail: String(error) }); });
  });
}

export function isCheckedValue(value: unknown): value is CheckedValue {
  return decodeCoreResponse({ version: 1, request_id: "effect-result", truncated: false, result: { status: "ok", value: { kind: "validated", value } } }) !== null;
}
export function isExternalHandle(value: unknown): value is ExternalHandle {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  if (value.kind === "completed") return "result" in value && isCheckedValue(value.result);
  if (value.kind === "kbbl_session") return "session_id" in value && typeof value.session_id === "string";
  if (value.kind === "repository") return "path" in value && typeof value.path === "string";
  if (value.kind === "pull_request") return "owner" in value && typeof value.owner === "string"
    && "name" in value && typeof value.name === "string" && "number" in value && typeof value.number === "number";
  return false;
}
export function isPositiveStop(value: unknown): value is { readonly stopped: true } {
  return !!value && typeof value === "object" && "stopped" in value && value.stopped === true;
}
export function isTerminal(value: unknown): value is { readonly kind: "terminal"; readonly result: CheckedValue; readonly evidence?: Trigger } {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "terminal" && "result" in value && isCheckedValue(value.result);
}

/** What one start attempt taught us: either a settled row, or "try again". */
export type StartOutcome =
  | { readonly kind: "acknowledged"; readonly payload: EffectPayload }
  | { readonly kind: "completed"; readonly payload: EffectPayload; readonly result: CheckedValue }
  | { readonly kind: "rejected"; readonly payload: EffectPayload }
  | { readonly kind: "retry"; readonly payload: EffectPayload };

export function startAttemptsExhausted(payload: EffectPayload): boolean {
  return (payload.start_attempts ?? 0) >= payload.invocation.selection.definition.max_attempts;
}
function retryStart(payload: EffectPayload): StartOutcome {
  return startAttemptsExhausted(payload)
    ? { kind: "rejected", payload: { ...payload, last_detail: `start attempts exhausted (${payload.start_attempts}): ${payload.last_detail ?? "provider unavailable"}` } }
    : { kind: "retry", payload };
}

export function resolveStart(payload: EffectPayload, result: ProviderResult<unknown>): StartOutcome {
  const dispatched: EffectPayload = { ...payload, has_dispatched: true, start_attempts: payload.start_attempts ?? 1 };
  switch (result.kind) {
    case "acknowledged": {
      if (!isExternalHandle(result.value)) return retryStart({ ...dispatched, has_uncertain_start: true, last_detail: "provider acknowledged start without a valid handle" });
      const handle = result.value;
      if (handle.kind === "completed") {
        const evidence = handle.evidence ? { evidence: handle.evidence } : {};
        return { kind: "completed", payload: { ...dispatched, handle, ...evidence }, result: handle.result };
      }
      return { kind: "acknowledged", payload: { ...dispatched, handle } };
    }
    case "permanently_rejected":
      return { kind: "rejected", payload: { ...dispatched, last_detail: `${result.code}: ${result.detail}`, ...(result.evidence ? { evidence: result.evidence } : {}) } };
    case "transiently_unavailable":
      return retryStart({ ...dispatched, last_detail: result.detail });
    case "uncertain":
      return retryStart({ ...dispatched, has_uncertain_start: true, last_detail: result.detail });
  }
}

export type ObserveOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "terminal"; readonly payload: EffectPayload; readonly result: CheckedValue }
  | { readonly kind: "retry"; readonly payload: EffectPayload };

export function resolveObserve(payload: EffectPayload, result: ProviderResult<TerminalObservation | unknown>): ObserveOutcome {
  if (result.kind === "acknowledged") {
    if (isTerminal(result.value)) return { kind: "terminal", payload: { ...payload, ...(result.value.evidence ? { evidence: result.value.evidence } : {}) }, result: result.value.result };
    if (!!result.value && typeof result.value === "object" && "kind" in result.value && result.value.kind === "running") return { kind: "running" };
    // A malformed terminal observation cannot confirm cleanup.
    return { kind: "retry", payload: { ...payload, last_detail: "provider returned a malformed terminal observation" } };
  }
  const detail = result.kind === "permanently_rejected" ? `${result.code}: ${result.detail}` : result.detail;
  return { kind: "retry", payload: { ...payload, last_detail: detail } };
}

export type StopOutcome = { readonly kind: "confirmed" } | { readonly kind: "retry"; readonly detail: string };
/** Only a positive acknowledgement proves termination. */
export function resolveStop(result: ProviderResult<unknown>): StopOutcome {
  if (result.kind === "acknowledged") return isPositiveStop(result.value) ? { kind: "confirmed" } : { kind: "retry", detail: "provider returned a malformed stop acknowledgement" };
  return { kind: "retry", detail: result.kind === "permanently_rejected" ? `${result.code}: ${result.detail}` : result.detail };
}
