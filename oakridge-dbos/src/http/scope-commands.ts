import type { CheckedValue, DefinitionBundle, Trigger } from "../core-client/generated-contracts";
import type { CoreClient } from "../core-client/client";
import { checkPublications, requestEvaluation, type MutationService } from "../storage/mutation-service";
import type { OutputPublication } from "../storage/commit";
import { stagePublications } from "../storage/stage-publications";
import { readSnapshot } from "../storage/snapshot-reader";
import type { RunId, ScopeId } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { findReceipt, requestDigest } from "../storage/receipts";
import { availableCommand, currentOutputRevision, currentTargetRevisions, targetsMatch, type TargetRevision } from "../storage/command-selection";
export { availableCommand, currentTargetRevisions, targetsMatch, type TargetRevision } from "../storage/command-selection";

export interface ScopeCommandRequest {
  readonly command_key: string;
  readonly payload: unknown;
  readonly request_id: string;
  readonly scope_id: ScopeId;
  readonly expected_scope_version: number;
  readonly targets: readonly TargetRevision[];
}
/** The reviewed artifact is an edit precondition, carried in the command payload. */
export interface EditCommandPayload {
  readonly output_key: string;
  readonly collection_key: string;
  readonly reviewed_revision_id: string;
  readonly prev_value: CheckedValue;
  readonly body: CheckedValue;
}
export type CommandError = MalformedRequestError | InvalidPayloadError | MissingEntityError | ConflictError | TransientServiceError | InternalFaultError;
export type CommandResult = { readonly ok: true; readonly value: PendingWork } | { readonly ok: false; readonly error: CommandError };

export class MalformedRequestError { readonly kind = "malformed_request"; constructor(readonly detail: string) {} }
export class InvalidPayloadError { readonly kind = "invalid_payload"; constructor(readonly detail: string) {} }
export class MissingEntityError { readonly kind = "missing_entity"; constructor(readonly detail: string) {} }
export class ConflictError { readonly kind = "conflict"; constructor(readonly detail: string) {} }
export class TransientServiceError { readonly kind = "transient_service"; constructor(readonly detail: string) {} }
export class InternalFaultError { readonly kind = "internal_fault"; readonly trace_id = crypto.randomUUID(); constructor(readonly detail: string) {} }
/** The body of an accepted command (202). */
export interface CommandReceipt { readonly kind: "accepted_pending"; readonly request_id: string; readonly transition_id: string; readonly scope_version: number }
export class PendingWork implements CommandReceipt { readonly kind = "accepted_pending"; constructor(readonly request_id: string, readonly transition_id: string, readonly scope_version: number) {} }

const isObject = (value: unknown): value is { readonly [key: string]: unknown } => value !== null && typeof value === "object" && !Array.isArray(value);
const isVersion = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function parseEditPayload(value: unknown): EditCommandPayload | MalformedRequestError {
  if (!isObject(value) || typeof value.output_key !== "string" || !value.output_key
    || typeof value.collection_key !== "string" || typeof value.reviewed_revision_id !== "string" || !value.reviewed_revision_id
    || !isObject(value.prev_value) || typeof value.prev_value.schema !== "string" || !isObject(value.prev_value.data)
    || !isObject(value.body) || typeof value.body.schema !== "string" || !isObject(value.body.data))
    return new MalformedRequestError("edit payload requires output_key, collection_key, reviewed_revision_id, prev_value and body");
  return value as unknown as EditCommandPayload;
}
export function parseScopeCommand(value: unknown, scope_id: ScopeId): ScopeCommandRequest | MalformedRequestError {
  if (!isObject(value) || typeof value.command_key !== "string" || !value.command_key || typeof value.request_id !== "string" || !value.request_id
    || value.scope_id !== scope_id || !isVersion(value.expected_scope_version) || !("payload" in value) || !Array.isArray(value.targets)
    || !value.targets.every((item: unknown) => isObject(item) && typeof item.identity === "string" && !!item.identity && isVersion(item.version)))
    return new MalformedRequestError("command_key, payload, request_id, scope_id, expected_scope_version and target revisions are required");
  return { command_key: value.command_key, payload: value.payload, request_id: value.request_id, scope_id,
    expected_scope_version: value.expected_scope_version, targets: value.targets as TargetRevision[] };
}

export interface CommandDependencies { readonly db: TransactionalSqlExecutor; readonly core: CoreClient; readonly mutations: MutationService }
export async function submitScopeCommand(deps: CommandDependencies, run_id: RunId, request: ScopeCommandRequest): Promise<CommandResult> {
  try {
    const request_digest = requestDigest(request);
    const prior = await findReceipt(deps.db, { run_id, scope_id: request.scope_id, ingress_id: request.request_id, request_digest });
    if (prior.kind === "replay") return { ok: true, value: new PendingWork(request.request_id, prior.receipt.transition_id, prior.receipt.scope_version) };
    if (prior.kind === "conflict") return { ok: false, error: new ConflictError("request ID reused with different command content") };
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
    const output_definition = bundle.scopes.find((item) => item.key === source.owner.scope_key)?.outputs.find((item) => item.edit_trigger === request.command_key);
    let outputs: readonly OutputPublication[] = [];
    if (output_definition) {
      const edit = parseEditPayload(request.payload);
      if (edit instanceof MalformedRequestError) return { ok: false, error: edit };
      if (edit.output_key !== output_definition.key || edit.body.schema !== output_definition.schema)
        return { ok: false, error: new InvalidPayloadError(`output ${edit.output_key} does not match declared schema`) };
      const current = await currentOutputRevision(deps.db, request.scope_id, edit.output_key, edit.collection_key);
      if (!current || current.revision_id !== edit.reviewed_revision_id || requestDigest(current.body) !== requestDigest(edit.prev_value))
        return { ok: false, error: new ConflictError(`output ${edit.output_key} changed since review`) };
      outputs = [{ scope_id: request.scope_id, output_key: edit.output_key, collection_key: edit.collection_key,
        body: edit.body, revision_id: crypto.randomUUID(),
        predecessor_id: edit.reviewed_revision_id, expected_slot_version: current.slot_version,
        execution_id: null }];
      const publication_check = await checkPublications(deps.core, bundle, source.owner.scope_key, outputs);
      if (!publication_check.ok) return { ok: false, error: new TransientServiceError(publication_check.error.detail) };
      if (publication_check.value.kind === "mismatch")
        return { ok: false, error: new InvalidPayloadError(`output ${publication_check.value.output_key} does not match declared schema`) };
    }
    const checked = await deps.core.request("validate_payload", { bundle, schema: command.payload_schema, payload: output_definition ? {} : request.payload });
    if (!checked.ok) return { ok: false, error: checked.error.kind === "transport" ? new TransientServiceError(checked.error.detail.detail) : new InvalidPayloadError(checked.error.detail.detail) };
    if (checked.value.kind !== "validated") return { ok: false, error: new InternalFaultError("core returned unexpected validation result") };
    const trigger: Trigger = { id: request.request_id, key: request.command_key, payload: checked.value.value };
    const decision_source = { ...source, snapshot: { ...source.snapshot, trigger } };
    const staged = outputs.length ? stagePublications(bundle, decision_source, outputs) : null;
    if (staged && !staged.ok) return { ok: false, error: new InvalidPayloadError(staged.error.detail) };
    const evaluated = await requestEvaluation(deps.core, { bundle, source: staged?.ok ? staged.value : decision_source });
    if (!evaluated.ok) return { ok: false, error: evaluated.error.kind === "transport" ? new TransientServiceError(evaluated.error.detail.detail) : new InvalidPayloadError(evaluated.error.detail.detail) };
    if (evaluated.value.kind !== "evaluated") return { ok: false, error: new InternalFaultError("core returned unexpected evaluation result") };
    if (evaluated.value.value.kind === "reject") return { ok: false, error: new InvalidPayloadError(evaluated.value.value.error) };
    const current_targets = await currentTargetRevisions(deps.db, request.scope_id, command, source.snapshot.observations);
    if (command.targets.length && !targetsMatch(command, evaluated.value.value, request.targets, current_targets)) return { ok: false, error: new ConflictError("target revisions changed") };
    const decided = await deps.mutations.decide({ run_id, scope_id: request.scope_id, ingress_id: request.request_id, trigger,
      operator_version: request.expected_scope_version, outputs,
      prepared: { request_digest, decision: { source: decision_source, outcome: evaluated.value.value }, target_revisions: request.targets } });
    if (!decided.ok) return { ok: false, error: new InternalFaultError(decided.error.detail) };
    if (decided.value.kind === "Conflict") return { ok: false, error: new ConflictError(decided.value.detail) };
    if (decided.value.kind === "Rejected") return { ok: false, error: new InvalidPayloadError(decided.value.detail) };
    if (decided.value.kind === "snapshot_too_large") return { ok: false, error: new InvalidPayloadError(`snapshot_too_large: ${decided.value.scope} ${decided.value.bytes}/${decided.value.limit}`) };
    return { ok: true, value: new PendingWork(request.request_id, decided.value.receipt.transition_id, decided.value.receipt.scope_version) };
  } catch (cause) { return { ok: false, error: new InternalFaultError(String(cause)) }; }
}

export function commandStatus(result: CommandResult): 202 | 400 | 404 | 409 | 422 | 500 | 503 {
  if (result.ok) return 202;
  return COMMAND_STATUS[result.error.kind];
}
export const COMMAND_STATUS = {
  malformed_request: 400, invalid_payload: 422, missing_entity: 404, conflict: 409,
  transient_service: 503, internal_fault: 500,
} as const satisfies Readonly<Record<CommandError["kind"], 400 | 404 | 409 | 422 | 500 | 503>>;
