import type { WorkerRuntime } from "../core-client/core-types";

/** The runtime, model and effort an agent worker starts with. */
export interface SessionSettings { readonly harness: string; readonly model: string; readonly effort: string | null }
/** Launch settings are keyed separately by stage and worker. */
export interface RunConfig {
  readonly sessions: { readonly [stage: string]: { readonly [worker: string]: SessionSettings } };
}

type Fields = { readonly [key: string]: unknown };
const isFields = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const parseSessionSettings = (value: unknown): SessionSettings | null =>
  isFields(value) && isText(value.harness) && isText(value.model) && (value.effort === null || value.effort === undefined || isText(value.effort))
    ? { harness: value.harness, model: value.model, effort: value.effort ?? null } : null;

/** A launch's exact worker settings, or null for a malformed config. */
export function parseRunConfig(value: unknown): RunConfig | null {
  if (!isFields(value) || !isFields(value.sessions)) return null;
  const stages: (readonly [string, { readonly [worker: string]: SessionSettings }])[] = [];
  for (const [stage, rawWorkers] of Object.entries(value.sessions)) {
    if (!isFields(rawWorkers)) return null;
    const workers: (readonly [string, SessionSettings])[] = [];
    for (const [worker, rawSettings] of Object.entries(rawWorkers)) {
      const settings = parseSessionSettings(rawSettings);
      if (settings === null) return null;
      workers.push([worker, settings]);
    }
    stages.push([stage, Object.fromEntries(workers)]);
  }
  // fromEntries keeps even names like `__proto__` as own properties.
  return { sessions: Object.fromEntries(stages) };
}

export interface SessionSettingsTarget { readonly stage: string; readonly worker: string }

/** The exact worker choice, or the runtime declared by the pinned workflow. */
export function selectWorkerSessionSettings(config: RunConfig | null, target: SessionSettingsTarget,
  declared: WorkerRuntime | null): SessionSettings | null {
  const stage = config && Object.hasOwn(config.sessions, target.stage) ? config.sessions[target.stage] : undefined;
  if (stage && Object.hasOwn(stage, target.worker)) return stage[target.worker];
  return declared ? { harness: declared.harness, model: declared.model, effort: null } : null;
}
