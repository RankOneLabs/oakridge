import { RUNTIME_EFFORTS, RUNTIME_MODELS, type RuntimeId, type RuntimeModelSelection } from "../../../kbbl/core/runtime";
import { err, ok, type Result } from "./primitives";

/** A null field inherits from the next less specific policy entry. */
export interface SessionSettings {
  readonly runtime: RuntimeId | null;
  readonly model: string | null;
  readonly effort: string | null;
}

export type SessionScopeSelector =
  | { readonly kind: "run" }
  | { readonly kind: "stage"; readonly stage_key: string }
  | { readonly kind: "cohort"; readonly stage_key: string; readonly cohort_key: string }
  | { readonly kind: "stage_worker"; readonly stage_key: string; readonly worker_key: string }
  | { readonly kind: "stage_worker_action"; readonly stage_key: string; readonly worker_key: string; readonly action_key: string };

export interface SessionPolicyEntry { readonly selector: SessionScopeSelector; readonly settings: SessionSettings }
export interface SessionPolicy { readonly version: number; readonly entries: readonly SessionPolicyEntry[] }
/** Project row state: the policy's own version and the row's optimistic version. */
export interface SessionPolicyState { readonly policy: SessionPolicy; readonly version: number }

export type SessionSettingProvenance =
  | { readonly kind: "bundle_default" }
  | { readonly kind: "policy"; readonly selector: SessionScopeSelector };
export interface ResolvedSessionSettings {
  readonly runtime: RuntimeId;
  readonly model: string | null;
  readonly effort: string | null;
  readonly provenance: {
    readonly runtime: SessionSettingProvenance;
    readonly model: SessionSettingProvenance;
    readonly effort: SessionSettingProvenance;
  };
}
/** Persisted on a chosen invocation so later policy edits cannot change it. */
export interface SessionInvocationSettings {
  readonly runtime: RuntimeId;
  readonly model: string | null;
  readonly effort: string | null;
  readonly policy_version: number;
}

export interface SessionSettingsContext {
  readonly stage_key: string;
  readonly cohort_key: string | null;
  readonly worker_key: string;
  readonly action_key: string;
  /** The bundle's declared default for this worker role, not a kbbl picker default. */
  readonly worker_defaults: readonly [RuntimeModelSelection, ...RuntimeModelSelection[]];
}
export interface SessionSettingsError {
  readonly operation: "resolve_session_settings";
  readonly entity_id: string;
  readonly field: "runtime" | "model" | "effort";
  readonly value: string;
  readonly detail: string;
}

export function resolveSessionSettings(policy: SessionPolicy, context: SessionSettingsContext): Result<ResolvedSessionSettings, SessionSettingsError> {
  const matching = policy.entries
    .filter(({ selector }) => matchesSelector(selector, context))
    .map((entry, order) => ({ ...entry, order }))
    .sort((left, right) => specificity(left.selector) - specificity(right.selector) || left.order - right.order);
  const supplied = (field: keyof SessionSettings) => {
    const last = matching.filter((entry) => entry.settings[field] !== null).at(-1);
    return last ? { value: last.settings[field], selector: last.selector, rank: specificity(last.selector) } : null;
  };
  const runtime_entry = supplied("runtime");
  const runtime = (runtime_entry?.value ?? context.worker_defaults[0].runtime) as RuntimeId;
  const defaults = context.worker_defaults.find((item) => item.runtime === runtime);
  if (!defaults) return err({ operation: "resolve_session_settings", entity_id: context.worker_key,
    field: "runtime", value: runtime, detail: `bundle has no ${context.worker_key} default for ${runtime}` });
  const runtime_provenance: SessionSettingProvenance = runtime_entry
    ? { kind: "policy", selector: runtime_entry.selector } : { kind: "bundle_default" };

  const resolveOption = (field: "model" | "effort", options: readonly { readonly value: string }[], fallback: string | null) => {
    const source = supplied(field);
    const candidate = source?.value ?? fallback;
    if (candidate === null) return ok({ value: null, provenance: { kind: "bundle_default" } as SessionSettingProvenance });
    if (options.some((option) => option.value === candidate)) return ok({ value: candidate,
      provenance: source ? { kind: "policy", selector: source.selector } as SessionSettingProvenance : { kind: "bundle_default" } as SessionSettingProvenance });
    if (source && runtime_entry && source.rank < runtime_entry.rank) {
      if (fallback === null || options.some((option) => option.value === fallback))
        return ok({ value: fallback, provenance: { kind: "bundle_default" } as SessionSettingProvenance });
    }
    return err({ operation: "resolve_session_settings", entity_id: context.worker_key, field,
      value: candidate, detail: `${field} ${candidate} is not advertised by ${runtime}` } as SessionSettingsError);
  };
  const model = resolveOption("model", RUNTIME_MODELS[runtime], defaults.model);
  if (!model.ok) return model;
  const effort = resolveOption("effort", RUNTIME_EFFORTS[runtime], defaults.effort ?? null);
  if (!effort.ok) return effort;
  return ok({ runtime, model: model.value.value, effort: effort.value.value,
    provenance: { runtime: runtime_provenance, model: model.value.provenance, effort: effort.value.provenance } });
}

function specificity(selector: SessionScopeSelector): number {
  switch (selector.kind) {
    case "run": return 0;
    case "stage": return 1;
    case "cohort": return 2;
    case "stage_worker": return 3;
    case "stage_worker_action": return 4;
  }
}

function matchesSelector(selector: SessionScopeSelector, context: SessionSettingsContext): boolean {
  switch (selector.kind) {
    case "run": return true;
    case "stage": return selector.stage_key === context.stage_key;
    case "cohort": return selector.stage_key === context.stage_key && selector.cohort_key === context.cohort_key;
    case "stage_worker": return selector.stage_key === context.stage_key && selector.worker_key === context.worker_key;
    case "stage_worker_action": return selector.stage_key === context.stage_key && selector.worker_key === context.worker_key && selector.action_key === context.action_key;
  }
}
