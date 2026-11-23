import { canonicalDigest } from "canonical-json";
import { err, ok, type Result } from "../domain/primitives";
import type { CommittedEventDelivery, DeliveredRevision } from "./dbos-revision-delivery";
import { isDeliveryCursor } from "./cursor";

export interface CaptureSource extends Omit<DeliveredRevision, "artifact" | "schema_version"> {
  readonly producer: string;
  readonly namespace: string;
  readonly artifact_kind: string;
  readonly artifact_schema_version: string;
}
export interface CaptureError { readonly operation: "decode_revision_delivery"; readonly entity_id: string; readonly detail: string }

const object = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const optionalId = (value: unknown): boolean => value === null || text(value);
const failure = (entity_id: string, detail: string): Result<never, CaptureError> =>
  err({ operation: "decode_revision_delivery", entity_id, detail });

function isRevision(value: unknown, run_id: string): boolean {
  if (!object(value) || value.run_id !== run_id) return false;
  if (!["revision_id", "unit_id", "stage", "artifact", "definition_id", "schema_version", "recorded_at"].every((key) => text(value[key]))) return false;
  if (typeof value.recorded_at !== "string" || !Number.isFinite(Date.parse(value.recorded_at))) return false;
  if (!optionalId(value.predecessor_id) || !optionalId(value.subject_id)) return false;
  const origin = value.origin;
  if (!object(origin) || !(origin.kind === "operator_edit" ||
    (origin.kind === "worker" && text(origin.action_id) && Number.isSafeInteger(origin.seq) && Number(origin.seq) >= 0))) return false;
  if (!Array.isArray(value.input_bindings) || !value.input_bindings.every((binding: unknown) =>
    object(binding) && text(binding.input) && text(binding.unit) && text(binding.revision_id))) return false;
  const digest = canonicalDigest(value.body);
  return digest.ok && digest.value === value.body_digest;
}

function isRunConfig(value: unknown): boolean {
  return object(value) && typeof value.grading_enabled === "boolean" && object(value.sessions)
    && Object.values(value.sessions).every((stage) => object(stage) && Object.values(stage).every((worker) =>
      object(worker) && text(worker.harness) && text(worker.model) && (worker.effort === null || text(worker.effort))));
}

export function decodeRevisionDelivery(input: unknown): Result<CommittedEventDelivery, CaptureError> {
  if (!object(input) || input.producer !== "oakridge" || !text(input.namespace) || !text(input.run_id)
    || !text(input.event_id) || !isDeliveryCursor(input.cursor) || !isDeliveryCursor(input.previous)
    || input.event_id !== input.cursor.event_id || !object(input.event))
    return failure("delivery", "invalid delivery identity or cursor");
  const { event, run_id, event_id } = input;
  switch (event.kind) {
    case "revisions":
      if (!Array.isArray(event.revisions) || !event.revisions.every((revision: unknown) => isRevision(revision, run_id)))
        return failure(event_id, "invalid delivered revision or body digest");
      break;
    case "launched":
      if (!text(event.input_schema_version) || !canonicalDigest(event.input).ok || !isRunConfig(event.config))
        return failure(event_id, "invalid launch input or configuration");
      break;
    case "other":
      if (!text(event.event_kind)) return failure(event_id, "event_kind is required");
      break;
    default: return failure(event_id, "unknown event kind");
  }
  return ok(input as unknown as CommittedEventDelivery);
}

export function selectCaptures(delivery: CommittedEventDelivery): readonly CaptureSource[] {
  if (delivery.event.kind !== "revisions") return [];
  return delivery.event.revisions.map((revision): CaptureSource => ({
    producer: delivery.producer, namespace: delivery.namespace, revision_id: revision.revision_id,
    run_id: revision.run_id, unit_id: revision.unit_id, stage: revision.stage,
    artifact_kind: revision.artifact, artifact_schema_version: revision.schema_version, definition_id: revision.definition_id,
    body: revision.body, body_digest: revision.body_digest, predecessor_id: revision.predecessor_id, subject_id: revision.subject_id,
    origin: revision.origin.kind === "operator_edit" ? { kind: "operator_edit" }
      : { kind: "worker", action_id: revision.origin.action_id, seq: revision.origin.seq },
    input_bindings: revision.input_bindings.map(({ input, unit, revision_id }) => ({ input, unit, revision_id })),
    recorded_at: revision.recorded_at,
  }));
}
