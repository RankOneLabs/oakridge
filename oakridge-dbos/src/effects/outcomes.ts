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
function retryStart(payload: EffectPayload, detail: string): StartOutcome {
  return startAttemptsExhausted(payload)
    ? { kind: "rejected", payload: { ...payload, failure: { kind: "start_attempts_exhausted", detail },
      last_detail: `start attempts exhausted (${payload.start_attempts}): ${detail}` } }
    : { kind: "retry", payload };
}

/** An exhausted unfinished reservation may have reached the provider before a crash. */
export function exhaustStart(payload: EffectPayload): StartOutcome {
  return { kind: "rejected", payload: { ...payload, start_in_flight: false,
    has_uncertain_start: payload.has_uncertain_start === true || payload.start_in_flight === true
      || (payload.start_in_flight === undefined && payload.has_dispatched === true),
    failure: { kind: "start_attempts_exhausted", detail: `start attempts exhausted (${payload.start_attempts ?? 0}) during recovery` },
    last_detail: `start attempts exhausted (${payload.start_attempts ?? 0}) during recovery` } };
}

export function resolveStart(payload: EffectPayload, result: ProviderResult<unknown>): StartOutcome {
  const dispatched: EffectPayload = { ...payload, has_dispatched: true, start_attempts: payload.start_attempts ?? 1, start_in_flight: false };
  switch (result.kind) {
    case "acknowledged": {
      if (!isExternalHandle(result.value)) return retryStart({ ...dispatched, has_uncertain_start: true, last_detail: "provider acknowledged start without a valid handle" }, "provider acknowledged start without a valid handle");
      const handle = result.value;
      if (handle.kind === "completed") {
        const evidence = handle.evidence ? { evidence: handle.evidence } : {};
        return { kind: "completed", payload: { ...dispatched, handle, ...evidence }, result: handle.result };
      }
      return { kind: "acknowledged", payload: { ...dispatched, handle } };
    }
    case "permanently_rejected":
      return { kind: "rejected", payload: { ...dispatched, failure: { kind: "provider_rejection", code: result.code, detail: result.detail },
        last_detail: `${result.code}: ${result.detail}`, ...(result.evidence ? { evidence: result.evidence } : {}) } };
    case "transiently_unavailable":
      return retryStart({ ...dispatched, last_detail: result.detail }, result.detail);
    case "uncertain":
      return retryStart({ ...dispatched, has_uncertain_start: true, last_detail: result.detail }, result.detail);
  }
}

export type ObserveOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "terminal"; readonly payload: EffectPayload; readonly result: CheckedValue }
  | { readonly kind: "rejected"; readonly payload: EffectPayload }
  | { readonly kind: "retry"; readonly payload: EffectPayload; readonly is_unavailable: boolean; readonly detail: string };

export function resolveObserve(payload: EffectPayload, result: ProviderResult<TerminalObservation | unknown>): ObserveOutcome {
  if (result.kind === "acknowledged") {
    if (isTerminal(result.value)) return { kind: "terminal", payload: { ...payload, ...(result.value.evidence ? { evidence: result.value.evidence } : {}) }, result: result.value.result };
    if (!!result.value && typeof result.value === "object" && "kind" in result.value && result.value.kind === "running") return { kind: "running" };
    // A malformed terminal observation cannot confirm cleanup.
    return { kind: "rejected", payload: { ...payload, failure: { kind: "observation_rejection", detail: "provider returned a malformed terminal observation" },
      last_detail: "provider returned a malformed terminal observation" } };
  }
  const detail = result.kind === "permanently_rejected" ? `${result.code}: ${result.detail}` : result.detail;
  if (result.kind === "permanently_rejected") return { kind: "rejected", payload: { ...payload, failure: { kind: "observation_rejection", detail },
    last_detail: detail, ...(result.evidence ? { evidence: result.evidence } : {}) } };
  return { kind: "retry", payload: { ...payload, last_detail: detail }, is_unavailable: result.kind === "transiently_unavailable", detail };
}

export function settleObserveRetry(payload: EffectPayload, outcome: Extract<ObserveOutcome, { readonly kind: "retry" }>, limit: number):
  { readonly status: "acknowledged" | "rejected"; readonly payload: EffectPayload } {
  const attempts = outcome.is_unavailable ? (payload.observe_unavailable_attempts ?? 0) + 1 : 0;
  const exhausted = outcome.is_unavailable && attempts >= Math.max(1, limit);
  return { status: exhausted ? "rejected" : "acknowledged",
    payload: { ...outcome.payload, observe_unavailable_attempts: attempts,
      ...(exhausted ? { failure: { kind: "observation_rejection" as const, detail: outcome.detail },
        last_detail: `observation unavailable after ${attempts} consecutive attempts: ${outcome.detail}` } : {}) } };
}

export type StopOutcome = { readonly kind: "confirmed" } | { readonly kind: "retry"; readonly detail: string };
/** Only a positive acknowledgement proves termination. */
export function resolveStop(result: ProviderResult<unknown>): StopOutcome {
  if (result.kind === "acknowledged") return isPositiveStop(result.value) ? { kind: "confirmed" } : { kind: "retry", detail: "provider returned a malformed stop acknowledgement" };
  return { kind: "retry", detail: result.kind === "permanently_rejected" ? `${result.code}: ${result.detail}` : result.detail };
}
