import type { WorkerRuntime } from "../core-client/core-types";

/** The runtime, model and effort an agent worker starts with. */
export interface SessionSettings { readonly harness: string; readonly model: string; readonly effort: string | null }
/** Launch settings. Sessions are keyed separately by stage and worker; a worker without one
 * uses the runtime its pinned workflow declares. */
export interface RunConfig {
  readonly sessions: { readonly [stage: string]: { readonly [worker: string]: SessionSettings } };
  /** Whether observation may send this run's items to the configured graders. Off unless chosen. */
  readonly grading_enabled: boolean;
}

type Fields = { readonly [key: string]: unknown };
const isFields = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const parseSessionSettings = (value: unknown): SessionSettings | null =>
  isFields(value) && isText(value.harness) && isText(value.model) && (value.effort === null || value.effort === undefined || isText(value.effort))
    ? { harness: value.harness, model: value.model, effort: value.effort ?? null } : null;

/** A launch's exact settings, or null for a malformed config. Absent sessions are none and an
 * absent grading choice is off; a supplied value of the wrong shape is malformed, never coerced. */
export function parseRunConfig(value: unknown): RunConfig | null {
  if (!isFields(value)) return null;
  const grading_enabled = value.grading_enabled === undefined ? false : value.grading_enabled;
  if (typeof grading_enabled !== "boolean") return null;
  const sessions = value.sessions === undefined ? {} : value.sessions;
  if (!isFields(sessions)) return null;
  const stages: (readonly [string, { readonly [worker: string]: SessionSettings }])[] = [];
  for (const [stage, rawWorkers] of Object.entries(sessions)) {
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
  return { sessions: Object.fromEntries(stages), grading_enabled };
}

export interface SessionSettingsTarget { readonly stage: string; readonly worker: string }

/** The exact worker choice, or the runtime declared by the pinned workflow. */
export function selectWorkerSessionSettings(config: RunConfig | null, target: SessionSettingsTarget,
  declared: WorkerRuntime | null): SessionSettings | null {
  const stage = config && Object.hasOwn(config.sessions, target.stage) ? config.sessions[target.stage] : undefined;
  if (stage && Object.hasOwn(stage, target.worker)) return stage[target.worker];
  return declared ? { harness: declared.harness, model: declared.model, effort: null } : null;
}
