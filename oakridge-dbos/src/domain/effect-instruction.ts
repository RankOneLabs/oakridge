import { createHash } from "node:crypto";
import type { Action, Mode, ParsedWorkflow, ResolvedRunWorker, RevisionState, SessionMode, TypeExpression, Workflow } from "../core-client/core-types";
import { selectWorkerSessionSettings, type RunConfig, type SessionSettings } from "./run-config";
import type { ActionId, Result, RunId } from "./primitives";

/** Provider start attempts an instruction may claim until the YAML carries a budget. */
export const DEFAULT_MAX_START_ATTEMPTS = 3;
/** Wall-clock budget for one provider call until the YAML carries a deadline. */
export const DEFAULT_PROVIDER_DEADLINE_MS = 600_000;

export type RunWorkerAction = Extract<Action, { readonly kind: "run_worker" }>;
/** A prompt path from the workflow source and the content digest pinned for it at compile. */
export interface PinnedPrompt { readonly path: string; readonly digest: string }
/** An artifact an agent creates, with its declared schema (named schemas resolved), for the publication block. */
export interface CreatedArtifact { readonly key: string; readonly schema: TypeExpression }
/** The prompt key whose template words a fresh session's handoff (part 1 §2.5). */
export const HANDOFF_PROMPT = "handoff";
export type WorkerInstruction =
  | { readonly kind: "agent"; readonly session_key: string; readonly session: SessionMode; readonly prompt: PinnedPrompt;
      /** The collection path that owns a shared session; absent for unit-owned sessions. */
      readonly shared_session_unit?: string;
      /** Pinned for `session: fresh` when the worker declares `prompts.handoff`; null otherwise. */
      readonly handoff: PinnedPrompt | null;
      /** What the session starts with: the run's worker or stage choice, else its declared runtime; null for kbbl's default. */
      readonly settings: SessionSettings | null; readonly creates: readonly CreatedArtifact[];
      /** Every named schema the created artifacts' schemas still reference (inside `list(...)`, `optional(...)`), transitively. */
      readonly schemas: { readonly [name: string]: TypeExpression } }
  | { readonly kind: "code"; readonly operation: string; readonly every: string | null;
      /** The one artifact a code worker creates, which its output is published as. */
      readonly artifact: string };
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
  readonly run_id: RunId;
  readonly action: RunWorkerAction;
  readonly attempt: { readonly action_id: ActionId; readonly seq: number };
  readonly worker: WorkerInstruction;
  readonly inputs: unknown;
  readonly engine_inputs: EngineInputs;
  readonly workspace: unknown;
  readonly deadline_ms: number;
  readonly max_start_attempts: number;
}
export interface InstructionError { readonly operation: string; readonly entity_id: string; readonly detail: string }

/** A periodic code worker's `every` (`30s`, `5m`, `1h`, as the compiler checks it) in seconds; null when it is not one. */
export function selectEverySeconds(every: string): number | null {
  const match = /^([1-9][0-9]*)([smh])$/.exec(every);
  if (!match) return null;
  const unit_seconds = { s: 1, m: 60, h: 3600 } as const;
  return Number(match[1]) * unit_seconds[match[2] as keyof typeof unit_seconds];
}

/**
 * The kbbl session key (part 1 §7.2). `resume` keeps one session per unit and
 * worker; `shared` keeps one for sibling units; `fresh` gives each action its own.
 * It is a sha256 hex with a mode prefix, so it is one short path segment however long the unit's path: kbbl
 * caps keys at 300, and unit ids and action ids grow with collection keys. kbbl
 * learns the owning unit or collection and worker from the ensure's `workflow` block, not the key.
 */
export function selectSessionKey(action: RunWorkerAction, action_id: string, session: SessionMode): string {
  const named = session === "resume" ? `resume\0${action.unit}\0${action.worker}`
    : session === "shared" ? `shared\0${selectSharedSessionUnit(action.unit)}\0${action.worker}` : `fresh\0${action_id}`;
  return `${session}-${createHash("sha256").update(named).digest("hex")}`;
}

/** The collection unit above one member, shared by all its siblings. */
export const selectSharedSessionUnit = (unit: string): string => unit.slice(0, unit.lastIndexOf("/"));

export interface InstructionSource {
  readonly run_id: RunId;
  readonly workflow: Workflow;
  readonly parsed_workflow?: ParsedWorkflow;
  /** prompt path -> content digest, as pinned on the definition bundle. */
  readonly prompts: { readonly [path: string]: string };
  readonly stage: string;
  readonly config: RunConfig | null;
  readonly action: RunWorkerAction;
  readonly seq: number;
  readonly resolved: ResolvedRunWorker;
}
const failure = (entity_id: string, detail: string): Result<never, InstructionError> =>
  ({ ok: false, error: { operation: "select_effect_instruction", entity_id, detail } });

/**
 * A schema with every exact reference to a named schema replaced by its
 * definition, so an agent reads the shape it must publish. A name inside a
 * compound type (`list(x)`) is left as written.
 */
export function selectResolvedSchema(schema: TypeExpression, schemas: { readonly [name: string]: TypeExpression }, depth = 0): TypeExpression {
  if (depth > 32) return schema;
  if (typeof schema === "string") {
    const named = Object.hasOwn(schemas, schema) ? schemas[schema] : undefined;
    return named === undefined ? schema : selectResolvedSchema(named, schemas, depth + 1);
  }
  return Object.fromEntries(Object.entries(schema).map(([field, type]) => [field, selectResolvedSchema(type, schemas, depth + 1)]));
}

/** The named schemas a set of types references anywhere, including inside compound types, transitively. */
export function selectReferencedSchemas(types: readonly TypeExpression[], schemas: { readonly [name: string]: TypeExpression }):
  { readonly [name: string]: TypeExpression } {
  const referenced: { [name: string]: TypeExpression } = {};
  const visit = (type: TypeExpression): void => {
    if (typeof type !== "string") { Object.values(type).forEach(visit); return; }
    for (const name of type.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      const named = Object.hasOwn(schemas, name) ? schemas[name] : undefined;
      if (named === undefined || Object.hasOwn(referenced, name)) continue;
      referenced[name] = named;
      visit(named);
    }
  };
  types.forEach(visit);
  return Object.fromEntries(Object.entries(referenced).sort(([left], [right]) => left.localeCompare(right)));
}

/** Build the instruction for a newly wanted RunWorker from its pinned definition and resolved inputs. */
export function selectEffectInstruction(source: InstructionSource): Result<EffectInstruction, InstructionError> {
  const { action, resolved } = source;
  const stage = source.workflow.stages[source.stage];
  const declared = source.parsed_workflow?.stages[source.stage]?.workers[action.worker]
    ?? stage?.workers[action.worker];
  if (!stage || !declared) return failure(resolved.action_id, `worker ${action.worker} is not declared on stage ${source.stage}`);
  const pin = (path: string): Result<PinnedPrompt, InstructionError> => {
    const digest = source.prompts[path];
    return digest === undefined ? failure(resolved.action_id, `prompt ${path} is not pinned`) : { ok: true, value: { path, digest } };
  };
  let worker: WorkerInstruction;
  if (declared.kind === "agent") {
    const path = declared.prompts[action.mode.kind];
    if (path == null) return failure(resolved.action_id, `agent ${action.worker} has no ${action.mode.kind} prompt`);
    const prompt = pin(path);
    if (!prompt.ok) return prompt;
    const session = declared.session ?? "resume";
    if (session === "shared" && (!action.unit.startsWith(`${source.run_id}/`) || selectSharedSessionUnit(action.unit) === source.run_id))
      return failure(resolved.action_id, "shared session requires a collection member unit");
    const handoff_path = session === "fresh" ? declared.prompts[HANDOFF_PROMPT] : undefined;
    const handoff = handoff_path == null ? null : pin(handoff_path);
    if (handoff && !handoff.ok) return handoff;
    const creates: CreatedArtifact[] = [];
    for (const key of declared.creates) {
      const artifact = stage.artifacts[key];
      if (!artifact) return failure(resolved.action_id, `artifact ${key} is not declared on stage ${source.stage}`);
      creates.push({ key, schema: selectResolvedSchema(artifact.schema, source.workflow.schemas ?? {}) });
    }
    worker = { kind: "agent", session, session_key: selectSessionKey(action, resolved.action_id, session),
      ...(session === "shared" ? { shared_session_unit: selectSharedSessionUnit(action.unit) } : {}),
      prompt: prompt.value, handoff: handoff?.value ?? null,
      settings: selectWorkerSessionSettings(source.config,
        { stage: source.stage, worker: action.worker }, declared.runtime ?? null), creates,
      schemas: selectReferencedSchemas(creates.map((artifact) => artifact.schema), source.workflow.schemas ?? {}) };
  } else {
    const artifact = declared.creates[0];
    if (declared.creates.length !== 1 || artifact === undefined)
      return failure(resolved.action_id, `code worker ${action.worker} must create exactly one artifact`);
    // Only a watch repeats: a retry of a periodic worker is one attempt, after which step opens a new watch.
    const every = action.cause.kind === "periodic" ? declared.every ?? null : null;
    worker = { kind: "code", operation: declared.operation, every, artifact };
  }
  return { ok: true, value: { version: 1, run_id: source.run_id, action, attempt: { action_id: resolved.action_id as ActionId, seq: source.seq }, worker,
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
    case "missing": return true;
    case "periodic": return isString(value.inputs) && isNullableString(value.replaces ?? null);
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
    && isNullableString(value.by ?? null) && isNullableString(value.predecessor ?? null) && isNullableString(value.subject ?? null);
}
const isNullableRevision = (value: unknown): value is RevisionState | null => value === null || isRevision(value);
const isPinnedPrompt = (value: unknown): value is PinnedPrompt => isFields(value) && isString(value.path) && isString(value.digest);
function isTypeExpression(value: unknown, depth = 0): value is TypeExpression {
  if (isString(value)) return true;
  return depth < 64 && isFields(value) && Object.values(value).every((member) => isTypeExpression(member, depth + 1));
}
const isCreatedArtifact = (value: unknown): value is CreatedArtifact => isFields(value) && isString(value.key) && isTypeExpression(value.schema);
function isWorkerInstruction(value: unknown): value is WorkerInstruction {
  if (!isFields(value)) return false;
  if (value.kind === "code") return isString(value.operation) && isNullableString(value.every) && isString(value.artifact);
  if (value.kind !== "agent") return false;
  const settings = value.settings;
  return isString(value.session_key) && (value.session === "resume" || value.session === "fresh" || value.session === "shared")
    && (value.session !== "shared" || isString(value.shared_session_unit) && value.shared_session_unit !== "")
    && isPinnedPrompt(value.prompt) && (value.handoff === null || isPinnedPrompt(value.handoff))
    && (settings === null || isFields(settings) && isString(settings.harness) && isString(settings.model) && isNullableString(settings.effort))
    && Array.isArray(value.creates) && value.creates.length > 0 && value.creates.every(isCreatedArtifact)
    && isFields(value.schemas) && Object.values(value.schemas).every((schema) => isTypeExpression(schema));
}
function isEngineInputs(value: unknown): value is EngineInputs {
  return isFields(value) && isNullableRevision(value.previous) && "feedback" in value && isNullableRevision(value.subject);
}

/** The executor's only way in: an `effect_intent.payload` that is not a version-1 instruction is refused. */
export function decodeEffectInstruction(value: unknown): Result<EffectInstruction, InstructionError> {
  const refuse = (detail: string): Result<never, InstructionError> =>
    ({ ok: false, error: { operation: "decode_effect_instruction", entity_id: isFields(value) && isFields(value.attempt) && isString(value.attempt.action_id) ? value.attempt.action_id : "unknown", detail } });
  if (!isFields(value) || value.version !== 1) return refuse("unsupported instruction version");
  if (!isString(value.run_id)) return refuse("run id is missing");
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
