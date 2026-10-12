import type { Action, Mode, ResolvedRunWorker, RevisionState, SessionMode, Workflow, WorkerRuntime } from "../core-client/core-types";
import type { Result } from "./primitives";

/** Provider start attempts an instruction may claim until the YAML carries a budget. */
export const DEFAULT_MAX_START_ATTEMPTS = 3;
/** Wall-clock budget for one provider call until the YAML carries a deadline. */
export const DEFAULT_PROVIDER_DEADLINE_MS = 600_000;

export type RunWorkerAction = Extract<Action, { readonly kind: "run_worker" }>;
/** A prompt path from the workflow source and the content digest pinned for it at compile. */
export interface PinnedPrompt { readonly path: string; readonly digest: string }
export type WorkerInstruction =
  | { readonly kind: "agent"; readonly session_key: string; readonly session: SessionMode; readonly prompt: PinnedPrompt; readonly runtime: WorkerRuntime | null }
  | { readonly kind: "code"; readonly operation: string; readonly every: string | null };
/** Inputs the engine adds for the action's mode; null where the mode has none. */
export interface EngineInputs {
  readonly previous: RevisionState | null;
  readonly feedback: unknown;
  readonly subject: RevisionState | null;
}
/**
 * Everything the executor needs to run one attempt, written by commit as
 * `effect_intent.payload` (rescue spec §2.5). It carries no secret: a
 * publication secret is minted when a session starts.
 */
export interface EffectInstruction {
  readonly version: 1;
  readonly action: RunWorkerAction;
  readonly attempt: { readonly action_id: string; readonly seq: number };
  readonly worker: WorkerInstruction;
  readonly inputs: unknown;
  readonly engine_inputs: EngineInputs;
  readonly workspace: unknown;
  readonly deadline_ms: number;
  readonly max_start_attempts: number;
}
export interface InstructionError { readonly operation: string; readonly entity_id: string; readonly detail: string }

/** One kbbl path segment: base64url never contains `/` or `.`. */
const segment = (text: string): string => Buffer.from(text).toString("base64url");
/** `session: resume` keeps one session per unit and worker; `fresh` gives each action its own (part 1 §7.2). */
export function selectSessionKey(action: RunWorkerAction, action_id: string, session: SessionMode): string {
  return session === "resume" ? `${segment(action.unit)}.${segment(action.worker)}` : segment(action_id);
}

export interface InstructionSource {
  readonly workflow: Workflow;
  /** prompt path -> content digest, as pinned on the definition bundle. */
  readonly prompts: { readonly [path: string]: string };
  readonly stage: string;
  readonly action: RunWorkerAction;
  readonly seq: number;
  readonly resolved: ResolvedRunWorker;
}
const failure = (entity_id: string, detail: string): Result<never, InstructionError> =>
  ({ ok: false, error: { operation: "select_effect_instruction", entity_id, detail } });

/** Build the instruction for a newly wanted RunWorker from its pinned definition and resolved inputs. */
export function selectEffectInstruction(source: InstructionSource): Result<EffectInstruction, InstructionError> {
  const { action, resolved } = source;
  const declared = source.workflow.stages[source.stage]?.workers[action.worker];
  if (!declared) return failure(resolved.action_id, `worker ${action.worker} is not declared on stage ${source.stage}`);
  let worker: WorkerInstruction;
  if (declared.kind === "agent") {
    const path = declared.prompts[action.mode.kind];
    if (path === undefined) return failure(resolved.action_id, `agent ${action.worker} has no ${action.mode.kind} prompt`);
    const digest = source.prompts[path];
    if (digest === undefined) return failure(resolved.action_id, `prompt ${path} is not pinned`);
    const session = declared.session ?? "resume";
    worker = { kind: "agent", session, session_key: selectSessionKey(action, resolved.action_id, session),
      prompt: { path, digest }, runtime: declared.runtime ?? null };
  } else worker = { kind: "code", operation: declared.operation, every: declared.every ?? null };
  return { ok: true, value: { version: 1, action, attempt: { action_id: resolved.action_id, seq: source.seq }, worker,
    inputs: resolved.inputs,
    engine_inputs: { previous: resolved.previous ?? null, feedback: resolved.feedback ?? null, subject: resolved.subject ?? null },
    workspace: resolved.workspace ?? null,
    deadline_ms: DEFAULT_PROVIDER_DEADLINE_MS, max_start_attempts: DEFAULT_MAX_START_ATTEMPTS } };
}

// ------------------------------------------------------------------ decoder --
// effect_intent.payload is read back as untyped JSON; the executor accepts it
// only through this decoder.

type Fields = { readonly [key: string]: unknown };
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isMode(value: unknown): value is Mode {
  return isFields(value) && (value.kind === "initial" || value.kind === "revise" || value.kind === "review");
}
function isCause(value: unknown): boolean {
  if (!isFields(value)) return false;
  switch (value.kind) {
    case "missing": case "periodic": return true;
    case "changes_requested": return isString(value.decision);
    case "review_of": return isString(value.revision);
    case "retry": return isString(value.event);
    default: return false;
  }
}
function isRunWorkerAction(value: unknown): value is RunWorkerAction {
  return isFields(value) && value.kind === "run_worker" && isString(value.unit) && isString(value.worker)
    && isMode(value.mode) && isCause(value.cause);
}
function isRevision(value: unknown): value is RevisionState {
  return isFields(value) && isString(value.id) && isString(value.unit) && isString(value.artifact) && "body" in value
    && isString(value.by) && isNullableString(value.predecessor ?? null) && isNullableString(value.subject ?? null);
}
const isNullableRevision = (value: unknown): value is RevisionState | null => value === null || isRevision(value);
function isWorkerInstruction(value: unknown): value is WorkerInstruction {
  if (!isFields(value)) return false;
  if (value.kind === "code") return isString(value.operation) && isNullableString(value.every);
  if (value.kind !== "agent") return false;
  const prompt = value.prompt;
  const runtime = value.runtime;
  return isString(value.session_key) && (value.session === "resume" || value.session === "fresh")
    && isFields(prompt) && isString(prompt.path) && isString(prompt.digest)
    && (runtime === null || isFields(runtime) && isString(runtime.harness) && isString(runtime.model));
}
function isEngineInputs(value: unknown): value is EngineInputs {
  return isFields(value) && isNullableRevision(value.previous) && "feedback" in value && isNullableRevision(value.subject);
}

/** The executor's only way in: an `effect_intent.payload` that is not a v1 instruction is refused. */
export function decodeEffectInstruction(value: unknown): Result<EffectInstruction, InstructionError> {
  const refuse = (detail: string): Result<never, InstructionError> =>
    ({ ok: false, error: { operation: "decode_effect_instruction", entity_id: isFields(value) && isFields(value.attempt) && isString(value.attempt.action_id) ? value.attempt.action_id : "unknown", detail } });
  if (!isFields(value) || value.version !== 1) return refuse("unsupported instruction version");
  if (!isRunWorkerAction(value.action)) return refuse("action is not a run_worker action");
  const attempt = value.attempt;
  if (!isFields(attempt) || !isString(attempt.action_id) || !isCount(attempt.seq)) return refuse("attempt is malformed");
  if (!isWorkerInstruction(value.worker)) return refuse("worker is malformed");
  if (!("inputs" in value) || !("workspace" in value)) return refuse("inputs or workspace missing");
  if (!isEngineInputs(value.engine_inputs)) return refuse("engine inputs are malformed");
  if (!isCount(value.deadline_ms) || value.deadline_ms === 0) return refuse("deadline is malformed");
  if (!isCount(value.max_start_attempts) || value.max_start_attempts === 0) return refuse("start budget is malformed");
  return { ok: true, value: value as unknown as EffectInstruction };
}
