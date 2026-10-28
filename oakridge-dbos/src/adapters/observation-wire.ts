/** Duplicated producer boundary contract. The contract test checks the service copy. */
export interface SourceEventCursor { readonly commit_txid: string; readonly id: string }
export const INITIAL_SOURCE_CURSOR: SourceEventCursor = { commit_txid: "0", id: "" };
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type CanonicalDigest = `canonical-json/v1:${string}` & { readonly __brand: "CanonicalDigest" };
export interface CaptureSource {
  readonly producer: string; readonly namespace: string; readonly revision_id: string; readonly run_id: string;
  readonly unit_id: string; readonly artifact_kind: string; readonly artifact_schema_version: string;
  readonly definition_bundle: { readonly id: string; readonly digest: string };
  readonly predecessor_id: string | null; readonly subject_id: string | null;
  readonly by_id?: string | null;
}
export interface CaptureEnvelope {
  readonly format: "observation.artifact-revision/v1"; readonly source: CaptureSource; readonly recorded_at: string;
  readonly body: JsonValue;
  readonly body_digest: CanonicalDigest;
}
export interface SourceEventProvenance { readonly format: "observation.source-event/v1";
  readonly definition_bundle: { readonly id: string; readonly digest: string } | null; readonly artifact_schema_version: string | null }
export type SourceEventOutcome = SourceEventProvenance & (
  | { readonly kind: "artifact_revision"; readonly event_kind: "revision_published"; readonly run_id: string; readonly event_id: string; readonly revision: CaptureEnvelope }
  | { readonly kind: "human_grade"; readonly event_kind: "operator_decided"; readonly run_id: string; readonly event_id: string;
      readonly decision_id: string | null;
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
