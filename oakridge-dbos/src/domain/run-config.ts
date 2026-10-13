import type { WorkerRuntime } from "../core-client/core-types";

/** The runtime, model and effort an agent session starts with. */
export interface SessionSettings { readonly harness: string; readonly model: string; readonly effort: string | null }
/**
 * What the operator chose at launch for the run's agent sessions, by stage.
 * A stage without an entry starts its sessions with its workers' declared runtime.
 */
export interface RunConfig { readonly sessions: { readonly [stage: string]: SessionSettings } }

type Fields = { readonly [key: string]: unknown };
const isFields = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const parseSessionSettings = (value: unknown): SessionSettings | null =>
  isFields(value) && isText(value.harness) && isText(value.model) && (value.effort === null || value.effort === undefined || isText(value.effort))
    ? { harness: value.harness, model: value.model, effort: value.effort ?? null } : null;

/** A launch's config, or null when it is not one: every entry names a stage and full settings. */
export function parseRunConfig(value: unknown): RunConfig | null {
  if (!isFields(value) || !isFields(value.sessions)) return null;
  const sessions: { [stage: string]: SessionSettings } = {};
  for (const [stage, raw] of Object.entries(value.sessions)) {
    const settings = parseSessionSettings(raw);
    if (settings === null) return null;
    sessions[stage] = settings;
  }
  return { sessions };
}

/** The settings an agent session of `stage` starts with: the run's choice for the stage, else the worker's declared runtime. */
export function selectSessionSettings(config: RunConfig | null, stage: string, declared: WorkerRuntime | null): SessionSettings | null {
  const chosen = config?.sessions[stage];
  if (chosen) return chosen;
  return declared ? { harness: declared.harness, model: declared.model, effort: null } : null;
}
