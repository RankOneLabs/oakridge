import type { WorkerRuntime } from "../core-client/core-types";

/** The runtime, model and effort an agent session starts with. */
export interface SessionSettings { readonly harness: string; readonly model: string; readonly effort: string | null }
/**
 * What the operator chose at launch for the run's agent sessions, by stage
 * or by a more specific `stage.worker` key. A worker without either entry
 * starts with its declared runtime.
 */
export interface RunConfig { readonly sessions: { readonly [stage_or_worker: string]: SessionSettings } }

type Fields = { readonly [key: string]: unknown };
const isFields = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const parseSessionSettings = (value: unknown): SessionSettings | null =>
  isFields(value) && isText(value.harness) && isText(value.model) && (value.effort === null || value.effort === undefined || isText(value.effort))
    ? { harness: value.harness, model: value.model, effort: value.effort ?? null } : null;

/** A launch's config, or null when it is not one: every entry has full settings. */
export function parseRunConfig(value: unknown): RunConfig | null {
  if (!isFields(value) || !isFields(value.sessions)) return null;
  const entries: (readonly [string, SessionSettings])[] = [];
  for (const [stage, raw] of Object.entries(value.sessions)) {
    const settings = parseSessionSettings(raw);
    if (settings === null) return null;
    entries.push([stage, settings]);
  }
  // fromEntries defines own properties, so a `__proto__` stage stays an entry rather than replacing the prototype.
  return { sessions: Object.fromEntries(entries) };
}

/** The settings an agent session of `stage` starts with: the run's choice for the stage, else the worker's declared runtime. */
export function selectSessionSettings(config: RunConfig | null, stage: string, declared: WorkerRuntime | null): SessionSettings | null {
  // An own entry only: a stage named like an Object.prototype member (`constructor`) has no choice made for it.
  const chosen = config !== null && Object.hasOwn(config.sessions, stage) ? config.sessions[stage] : undefined;
  if (chosen) return chosen;
  return declared ? { harness: declared.harness, model: declared.model, effort: null } : null;
}

export interface SessionSettingsTarget { readonly stage: string; readonly worker: string }

/** A worker's explicit choice wins over the stage fallback used by older runs. */
export function selectWorkerSessionSettings(config: RunConfig | null, target: SessionSettingsTarget,
  declared: WorkerRuntime | null): SessionSettings | null {
  const workerKey = `${target.stage}.${target.worker}`;
  if (config !== null && Object.hasOwn(config.sessions, workerKey)) return config.sessions[workerKey];
  return selectSessionSettings(config, target.stage, declared);
}
