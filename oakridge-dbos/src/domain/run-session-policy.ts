import type { JsonValue, Result } from "./primitives";
import { err, ok } from "./primitives";
import type { SessionPolicy, SessionPolicyEntry, SessionSettings } from "./session-settings";

/** Mirrors workflow-config's run_sessions record, decoded from the checked root input. */
export interface RunSessionInput {
  readonly planner?: SessionSettings | null;
  readonly worker?: SessionSettings | null;
  readonly spec_analysis?: SessionSettings | null;
  readonly planning?: SessionSettings | null;
  readonly brief_writing?: SessionSettings | null;
  readonly implementation?: SessionSettings | null;
  readonly final_integration?: SessionSettings | null;
}

export interface RunSessionInputError {
  readonly operation: "run_session_policy";
  readonly entity_id: string;
  readonly detail: string;
}

const STAGE_KEYS = ["spec_analysis", "planning", "brief_writing", "implementation", "final_integration"] as const;
const isRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (field: string): Result<never, RunSessionInputError> =>
  err({ operation: "run_session_policy", entity_id: `sessions.${field}`, detail: "invalid session settings in pinned run input" });

function settingsAt(sessions: { readonly [key: string]: JsonValue }, field: string): Result<SessionSettings | null, RunSessionInputError> {
  const value = sessions[field];
  if (value === undefined || value === null) return ok(null);
  if (!isRecord(value)) return failure(field);
  const { runtime, model, effort } = value;
  if (runtime !== null && runtime !== "claude-code" && runtime !== "codex") return failure(field);
  if (model !== null && typeof model !== "string") return failure(field);
  if (effort !== null && typeof effort !== "string") return failure(field);
  return ok({ runtime, model, effort });
}

/** The planner choice applies to every session action; build is the one worker override. */
export function policyFromRunInput(input: JsonValue): Result<SessionPolicy, RunSessionInputError> {
  if (!isRecord(input) || input.sessions === undefined || input.sessions === null) return ok({ version: 0, entries: [] });
  if (!isRecord(input.sessions)) return failure("root");
  const sessions = input.sessions;
  const entries: SessionPolicyEntry[] = [];
  const planner = settingsAt(sessions, "planner");
  if (!planner.ok) return planner;
  if (planner.value) entries.push({ selector: { kind: "run" }, settings: planner.value });
  for (const stage_key of STAGE_KEYS) {
    const stage = settingsAt(sessions, stage_key);
    if (!stage.ok) return stage;
    if (stage.value) entries.push({ selector: { kind: "stage", stage_key }, settings: stage.value });
  }
  const worker = settingsAt(sessions, "worker");
  if (!worker.ok) return worker;
  if (worker.value) entries.push({ selector: { kind: "stage_worker", stage_key: "implementation", worker_key: "build" }, settings: worker.value });
  return ok({ version: 0, entries });
}
