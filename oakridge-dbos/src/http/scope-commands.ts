import type { CheckedValue, CommandDefinition, DefinitionBundle, DecisionOutcome, Trigger, VersionedValue } from "../core-client/generated-contracts";
import type { CoreClient } from "../core-client/client";
import type { MutationService } from "../storage/mutation-service";
import { readSnapshot } from "../storage/snapshot-reader";
import type { RunId, ScopeId } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

export interface TargetRevision { readonly identity: string; readonly version: number }
export interface ScopeCommandRequest {
  readonly command_key: string;
  readonly payload: unknown;
  readonly request_id: string;
  readonly scope_id: ScopeId;
  readonly expected_scope_version: number;
  readonly targets: readonly TargetRevision[];
}
export type CommandError = MalformedRequestError | InvalidPayloadError | MissingEntityError | ConflictError | TransientServiceError | InternalFaultError;
export type CommandResult = { readonly ok: true; readonly value: PendingWork } | { readonly ok: false; readonly error: CommandError };

export class MalformedRequestError { readonly kind = "malformed_request"; constructor(readonly detail: string) {} }
export class InvalidPayloadError { readonly kind = "invalid_payload"; constructor(readonly detail: string) {} }
export class MissingEntityError { readonly kind = "missing_entity"; constructor(readonly detail: string) {} }
export class ConflictError { readonly kind = "conflict"; constructor(readonly detail: string) {} }
export class TransientServiceError { readonly kind = "transient_service"; constructor(readonly detail: string) {} }
export class InternalFaultError { readonly kind = "internal_fault"; readonly trace_id = crypto.randomUUID(); constructor(readonly detail: string) {} }
export class PendingWork { readonly kind = "accepted_pending"; constructor(readonly request_id: string, readonly transition_id: string, readonly scope_version: number) {} }

const isObject = (value: unknown): value is { readonly [key: string]: unknown } => value !== null && typeof value === "object" && !Array.isArray(value);
const isVersion = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parseScopeCommand(value: unknown, scope_id: ScopeId): ScopeCommandRequest | MalformedRequestError {
  if (!isObject(value) || typeof value.command_key !== "string" || !value.command_key || typeof value.request_id !== "string" || !value.request_id
    || value.scope_id !== scope_id || !isVersion(value.expected_scope_version) || !("payload" in value) || !Array.isArray(value.targets)
    || !value.targets.every((item: unknown) => isObject(item) && typeof item.identity === "string" && !!item.identity && isVersion(item.version)))
    return new MalformedRequestError("command_key, payload, request_id, scope_id, expected_scope_version and target revisions are required");
  return { command_key: value.command_key, payload: value.payload, request_id: value.request_id, scope_id,
    expected_scope_version: value.expected_scope_version, targets: value.targets as TargetRevision[] };
}

export function availableCommand(definition: DefinitionBundle, scope_key: string, state: CheckedValue, command_key: string): CommandDefinition | null {
  const command = definition.scopes.find((scope) => scope.key === scope_key)?.commands.find((item) => item.key === command_key);
  if (!command) return null;
  const state_key = state.data.kind === "variant" ? state.data.variant : state.data.kind === "enum" ? state.data.variant : null;
  return command.available_in.length === 0 || (state_key !== null && command.available_in.includes(state_key)) ? command : null;
}

export function targetsMatch(command: CommandDefinition, outcome: DecisionOutcome, submitted: readonly TargetRevision[], current: readonly TargetRevision[]): boolean {
  return outcome.kind === "apply" && outcome.targets.length === command.targets.length && submitted.length === current.length
    && current.length === command.targets.length && current.every((target, index) => target.identity === submitted[index]?.identity && target.version === submitted[index]?.version);
}
export async function currentTargetRevisions(db: TransactionalSqlExecutor, scope_id: ScopeId, command: CommandDefinition, observations: readonly VersionedValue[]): Promise<readonly TargetRevision[]> {
  const targets: TargetRevision[] = [];
  for (const expression of command.targets) {
    if (expression.kind !== "reference") return [];
    if (expression.root.kind === "output") {
      const output_key = expression.root.key;
      const slots = await db.query<{ id: string; current_revision_id: string | null; version: string | number }>(
        "SELECT id,current_revision_id,version FROM authority.output_slot WHERE scope_id=$1 AND output_key=$2 AND collection_key=''", [scope_id, output_key]);
      const slot = slots[0];
      if (!slot?.current_revision_id) return [];
      const observed = observations.find((item) => item.identity === slot.id && item.root.kind === "output" && item.root.key === output_key);
      if (!observed || observed.version !== Number(slot.version)) return [];
      targets.push({ identity: slot.current_revision_id, version: Number(slot.version) });
      continue;
    }
    const observed = observations.find((item) => JSON.stringify(item.root) === JSON.stringify(expression.root));
    if (!observed) return [];
    targets.push({ identity: observed.identity, version: observed.version });
  }
  return targets;
}

export interface CommandDependencies { readonly db: TransactionalSqlExecutor; readonly core: CoreClient; readonly mutations: MutationService }
export async function submitScopeCommand(deps: CommandDependencies, run_id: RunId, request: ScopeCommandRequest): Promise<CommandResult> {
  try {
    const source = await readSnapshot(deps.db, request.scope_id, { id: request.request_id, key: request.command_key,
      payload: { schema: "", data: { kind: "boolean", value: false } } });
    if (!source || source.owner.run_id !== run_id) return { ok: false, error: new MissingEntityError("scope not found in run") };
    if (source.owner.version !== request.expected_scope_version) return { ok: false, error: new ConflictError("scope version changed") };
    if (source.owner.is_terminal) return { ok: false, error: new ConflictError("scope is terminal") };
    const bundles = await deps.db.query<{ source: DefinitionBundle }>("SELECT b.source FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [run_id]);
    const bundle = bundles[0]?.source;
    if (!bundle) return { ok: false, error: new InternalFaultError("pinned definition missing") };
    const command = availableCommand(bundle, source.owner.scope_key, source.owner.local_state, request.command_key);
    if (!command) return { ok: false, error: new InvalidPayloadError("command is undeclared or unavailable in current state") };
    if (request.targets.length !== command.targets.length) return { ok: false, error: new InvalidPayloadError("target count differs from pinned definition") };
    const checked = await deps.core.request("validate_payload", { bundle, available_operations: bundle.operations, schema: command.payload_schema, payload: request.payload });
    if (!checked.ok) return { ok: false, error: checked.error.kind === "transport" ? new TransientServiceError(checked.error.detail.detail) : new InvalidPayloadError(checked.error.detail.detail) };
    if (checked.value.kind !== "validated") return { ok: false, error: new InternalFaultError("core returned unexpected validation result") };
    const trigger: Trigger = { id: request.request_id, key: request.command_key, payload: checked.value.value };
    const evaluated = await deps.core.request("evaluate", { bundle, available_operations: bundle.operations, snapshot: { ...source.snapshot, trigger } });
    if (!evaluated.ok) return { ok: false, error: evaluated.error.kind === "transport" ? new TransientServiceError(evaluated.error.detail.detail) : new InvalidPayloadError(evaluated.error.detail.detail) };
    if (evaluated.value.kind !== "evaluated") return { ok: false, error: new InternalFaultError("core returned unexpected evaluation result") };
    if (evaluated.value.value.kind === "reject") return { ok: false, error: new InvalidPayloadError(evaluated.value.value.error) };
    const current_targets = await currentTargetRevisions(deps.db, request.scope_id, command, source.snapshot.observations);
    if (command.targets.length && !targetsMatch(command, evaluated.value.value, request.targets, current_targets)) return { ok: false, error: new ConflictError("target revisions changed") };
    const decided = await deps.mutations.decide({ run_id, scope_id: request.scope_id, ingress_id: request.request_id, trigger,
      operator_version: request.expected_scope_version });
    if (!decided.ok) return { ok: false, error: new InternalFaultError(decided.error.detail) };
    if (decided.value.kind === "Conflict") return { ok: false, error: new ConflictError(decided.value.detail) };
    if (decided.value.kind === "Rejected") return { ok: false, error: new InvalidPayloadError(decided.value.detail) };
    return { ok: true, value: new PendingWork(request.request_id, decided.value.receipt.transition_id, decided.value.receipt.scope_version) };
  } catch (cause) { return { ok: false, error: new InternalFaultError(String(cause)) }; }
}

export function commandStatus(result: CommandResult): 202 | 400 | 404 | 409 | 422 | 500 | 503 {
  if (result.ok) return 202;
  if (result.error instanceof MalformedRequestError) return 400;
  if (result.error instanceof InvalidPayloadError) return 422;
  if (result.error instanceof MissingEntityError) return 404;
  if (result.error instanceof ConflictError) return 409;
  if (result.error instanceof TransientServiceError) return 503;
  return 500;
}
