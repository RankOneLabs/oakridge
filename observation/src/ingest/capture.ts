import { canonicalDigest } from "canonical-json";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { CanonicalDigest } from "../domain/identity";

export interface CaptureSource {
  readonly producer: string;
  readonly namespace: string;
  /** The complete external identity: producer:namespace:local revision id. */
  readonly revision_id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_kind: string;
  readonly artifact_schema_version: string;
  readonly definition_id: string;
  readonly predecessor_id: string | null;
  readonly subject_id: string | null;
  readonly by_id?: string | null;
}
export interface CaptureEnvelope {
  readonly format: "observation.artifact-revision/v2";
  readonly source: CaptureSource;
  readonly recorded_at: string;
  readonly body: JsonValue;
  readonly body_digest: CanonicalDigest;
}
export interface CaptureDelivery { readonly envelope: CaptureEnvelope; readonly local_revision_id: string }
export interface CaptureError { readonly operation: "decode_capture"; readonly entity_id: string; readonly detail: string }

function object(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function failure(entity_id: string, detail: string): Result<never, CaptureError> {
  return err({ operation: "decode_capture", entity_id, detail });
}

function revisionReference(value: unknown, prefix: string, field: string): Result<string | null, CaptureError> {
  if (value === undefined || value === null) return ok(null);
  if (!nonempty(value)) return failure(`source.${field}`, `${field} must be a revision id or null`);
  if (value.startsWith(prefix) && value.length > prefix.length) return ok(value);
  if (!value.includes(":")) return ok(`${prefix}${value}`);
  return failure(`source.${field}`, `${field} must belong to the capture tenant`);
}

/** Decode only fields from the accepted L0 envelope; canonical body hashing is the integrity check. */
export function decodeCapture(input: unknown): Result<CaptureDelivery, CaptureError> {
  if (!object(input) || input.format !== "observation.artifact-revision/v2") return failure("envelope", "invalid capture format");
  if (!object(input.source)) return failure("source", "source is required");
  const source = input.source;
  for (const field of ["producer", "namespace", "revision_id", "run_id", "unit_id", "artifact_kind", "artifact_schema_version", "definition_id"] as const)
    if (!nonempty(source[field])) return failure(`source.${field}`, `${field} is required`);
  const revision_id = source.revision_id;
  if (!nonempty(revision_id)) return failure("source.revision_id", "revision_id is required");
  const prefix = `${source.producer}:${source.namespace}:`;
  if (!revision_id.startsWith(prefix) || revision_id.length === prefix.length)
    return failure("source.revision_id", "revision identity must match source producer and namespace");
  const predecessor = revisionReference(source.predecessor_id, prefix, "predecessor_id");
  if (!predecessor.ok) return predecessor;
  const subject = revisionReference(source.subject_id, prefix, "subject_id");
  if (!subject.ok) return subject;
  if (!nonempty(input.recorded_at) || Number.isNaN(Date.parse(input.recorded_at))) return failure("recorded_at", "valid recorded_at is required");
  if (!Object.hasOwn(input, "body") || input.body === null) return failure("body", "a non-null body is required");
  const digest = canonicalDigest(input.body);
  if (!digest.ok) return failure("body", digest.error.detail);
  if (input.body_digest !== digest.value) return failure("body_digest", "body_digest does not match the canonical body");
  const envelope: CaptureEnvelope = { ...(input as unknown as CaptureEnvelope),
    source: { ...(source as unknown as CaptureSource), predecessor_id: predecessor.value, subject_id: subject.value } };
  return ok({ local_revision_id: revision_id.slice(prefix.length), envelope });
}
