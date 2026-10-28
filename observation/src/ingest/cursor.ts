import type { CaptureEnvelope } from "./capture";

/** The producer's durable position in authority.event, represented as decimal text to avoid bigint precision loss. */
export interface SourceEventCursor { readonly commit_txid: string; readonly id: string }
export const INITIAL_SOURCE_CURSOR: SourceEventCursor = { commit_txid: "0", id: "" };

export interface SourceEventProvenance { readonly format: "observation.source-event/v1";
  readonly definition_bundle: { readonly id: string; readonly digest: string } | null; readonly artifact_schema_version: string | null }
export type SourceEventOutcome = SourceEventProvenance & (
  | { readonly kind: "artifact_revision"; readonly event_kind: "revision_published"; readonly run_id: string; readonly event_id: string; readonly revision: CaptureEnvelope }
  | { readonly kind: "human_grade"; readonly event_kind: "operator_decided"; readonly run_id: string; readonly event_id: string;
      readonly evaluator: { readonly kind: "human" }; readonly unit: string; readonly review: string; readonly decision: string;
      readonly target: string; readonly feedback: unknown; readonly effect: "approve" | "request_changes" | null;
      readonly decided_at: string }
  | { readonly kind: "collaboration_thread"; readonly event_kind: "collaboration_thread"; readonly run_id: string;
      readonly event_id: string; readonly unit: string; readonly revision_id: string | null;
      readonly context: { readonly title: string; readonly anchor: string | null };
      readonly messages: readonly { readonly id: string; readonly body: { readonly text: string; readonly author: string };
        readonly created_at: string }[] }
  | { readonly kind: "run_input"; readonly event_kind: "launched"; readonly run_id: string; readonly event_id: string; readonly input: unknown;
      readonly input_schema_version: string }
  | { readonly kind: "ignored"; readonly event_kind: "worker_started" | "worker_ended" | "retry_requested" | "cancel_requested";
      readonly run_id: string; readonly event_id: string }
  | { readonly kind: "unmapped"; readonly event_kind: string; readonly run_id: string; readonly event_id: string; readonly reason: string });

export interface SourceEventDelivery { readonly previous: SourceEventCursor; readonly cursor: SourceEventCursor; readonly outcome: SourceEventOutcome }
export interface SourceEventAck { readonly cursor: SourceEventCursor }

function record(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cursor(value: unknown): value is SourceEventCursor {
  return record(value) && typeof value.commit_txid === "string" && /^(0|[1-9][0-9]*)$/.test(value.commit_txid)
    && BigInt(value.commit_txid) <= 9223372036854775807n && typeof value.id === "string";
}
export function decodeSourceEventDelivery(value: unknown): SourceEventDelivery | null {
  if (!record(value) || !cursor(value.previous) || !cursor(value.cursor) || !record(value.outcome)) return null;
  const outcome = value.outcome;
  if (typeof outcome.kind !== "string" || typeof outcome.event_kind !== "string" || typeof outcome.run_id !== "string"
    || typeof outcome.event_id !== "string" || outcome.event_id !== value.cursor.id) return null;
  if (outcome.format !== "observation.source-event/v1" || !(outcome.artifact_schema_version === null || typeof outcome.artifact_schema_version === "string")) return null;
  if (outcome.definition_bundle !== null && (!record(outcome.definition_bundle)
    || typeof outcome.definition_bundle.id !== "string" || typeof outcome.definition_bundle.digest !== "string")) return null;
  if (outcome.kind === "artifact_revision" && (!record(outcome.revision) || outcome.revision.format !== "observation.artifact-revision/v1")) return null;
  if (outcome.kind === "human_grade" && (!record(outcome.evaluator) || outcome.evaluator.kind !== "human" || typeof outcome.target !== "string")) return null;
  if (outcome.kind === "unmapped" && typeof outcome.reason !== "string") return null;
  if (!["artifact_revision", "human_grade", "run_input", "ignored", "unmapped"].includes(outcome.kind)) return null;
  return value as unknown as SourceEventDelivery;
}
