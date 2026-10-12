import type { MutationService } from "../storage/mutation-service";
import type { RunId, UnitId, UnitRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import type { CoreClient } from "../core-client/client";
import { selectAvailableDecisions } from "../projections/unit-view";
import type { Workflow, Writer } from "../core-client/core-types";

/**
 * An operator decision on a unit's review. v1 commands are gone: every
 * operator write is now one `operator_decided` event through the mutation
 * service, idempotent on request_id via authority.ingress_receipt.
 */
export interface UnitDecisionRequest {
  readonly unit_id: UnitId;
  readonly review: string;
  readonly decision: string;
  readonly target_revision_id: string;
  readonly payload: unknown;
  readonly request_id: string;
  readonly expected_unit_version: number;
}

export type CommandError = MalformedRequestError | InvalidPayloadError | MissingEntityError | ConflictError | TransientServiceError | InternalFaultError;
export type CommandResult = { readonly ok: true; readonly value: PendingWork } | { readonly ok: false; readonly error: CommandError };

export class MalformedRequestError { readonly kind = "malformed_request"; constructor(readonly detail: string) {} }
export class InvalidPayloadError { readonly kind = "invalid_payload"; constructor(readonly detail: string) {} }
export class MissingEntityError { readonly kind = "missing_entity"; constructor(readonly detail: string) {} }
export class ConflictError { readonly kind = "conflict"; constructor(readonly detail: string) {} }
export class TransientServiceError { readonly kind = "transient_service"; constructor(readonly detail: string) {} }
export class InternalFaultError { readonly kind = "internal_fault"; readonly trace_id = crypto.randomUUID(); constructor(readonly detail: string) {} }

/** The body of an accepted decision (202). */
export interface CommandReceipt { readonly kind: "accepted_pending"; readonly request_id: string; readonly event_id: string; readonly unit_version: number }
export class PendingWork implements CommandReceipt {
  readonly kind = "accepted_pending";
  constructor(readonly request_id: string, readonly event_id: string, readonly unit_version: number) {}
}

const isObject = (value: unknown): value is { readonly [key: string]: unknown } => value !== null && typeof value === "object" && !Array.isArray(value);
const isVersion = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parseUnitDecision(value: unknown, unit_id: UnitId): UnitDecisionRequest | MalformedRequestError {
  if (!isObject(value) || typeof value.review !== "string" || !value.review
    || typeof value.decision !== "string" || !value.decision
    || typeof value.target_revision_id !== "string" || !value.target_revision_id
    || typeof value.request_id !== "string" || !value.request_id
    || value.unit_id !== unit_id || !isVersion(value.expected_unit_version) || !("payload" in value))
    return new MalformedRequestError("review, decision, target_revision_id, payload, request_id, unit_id and expected_unit_version are required");
  return { unit_id, review: value.review, decision: value.decision, target_revision_id: value.target_revision_id,
    payload: value.payload, request_id: value.request_id, expected_unit_version: value.expected_unit_version };
}

export interface CommandDependencies { readonly db: TransactionalSqlExecutor; readonly core: CoreClient; readonly mutations: MutationService }

/**
 * The unit's version is an operator precondition checked before submitting;
 * the evaluator still re-checks the decision target under the run lock.
 */
export async function submitUnitDecision(deps: CommandDependencies, run_id: RunId, request: UnitDecisionRequest, writer: Writer): Promise<CommandResult> {
  try {
    const unit = (await deps.db.query<UnitRecord>("SELECT * FROM authority.unit WHERE run_id=$1 AND id=$2", [run_id, request.unit_id]))[0];
    if (!unit) return { ok: false, error: new MissingEntityError("unit not found in run") };
    if (Number(unit.version) !== request.expected_unit_version)
      return { ok: false, error: new ConflictError("unit changed; refresh the decision") };
    const pinned = (await deps.db.query<{ source: Workflow }>(
      "SELECT b.source FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [run_id]))[0];
    if (!pinned) return { ok: false, error: new MissingEntityError("pinned definition not found") };
    const offered = selectAvailableDecisions(pinned.source, unit.stage)
      .some((item) => item.review === request.review && item.decision === request.decision);
    if (!offered) return { ok: false, error: new InvalidPayloadError("decision is not offered by this unit's stage") };

    const submitted = await deps.mutations.submit({
      run_id, ingress_id: request.request_id, writer,
      event: { kind: "operator_decided", unit: request.unit_id, review: request.review,
        decision: request.decision, target: request.target_revision_id, payload: request.payload },
    });
    if (!submitted.ok) return { ok: false, error: new InternalFaultError(submitted.error.detail) };
    const result = submitted.value;
    if (result.kind === "committed" || result.kind === "replayed")
      return { ok: true, value: new PendingWork(request.request_id, result.event_id, request.expected_unit_version) };
    return result.kind === "conflict"
      ? { ok: false, error: new ConflictError(result.detail) }
      : { ok: false, error: new InvalidPayloadError(result.detail) };
  } catch (cause) {
    return { ok: false, error: new InternalFaultError(String(cause)) };
  }
}

export function commandStatus(result: CommandResult): 202 | 400 | 404 | 409 | 422 | 500 | 503 {
  if (result.ok) return 202;
  switch (result.error.kind) {
    case "malformed_request": return 400;
    case "missing_entity": return 404;
    case "conflict": return 409;
    case "invalid_payload": return 422;
    case "transient_service": return 503;
    default: return 500;
  }
}
