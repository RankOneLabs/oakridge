/** Duplicated producer boundary contract. The contract test checks the service copy. */
export interface SourceEventCursor { readonly commit_txid: string; readonly id: string }
export const INITIAL_SOURCE_CURSOR: SourceEventCursor = { commit_txid: "0", id: "" };
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type CanonicalDigest = `canonical-json/v1:${string}` & { readonly __brand: "CanonicalDigest" };
export interface CaptureSource {
  readonly producer: string; readonly namespace: string; readonly revision_id: string; readonly run_id: string;
  readonly unit_id: string; readonly artifact_kind: string; readonly artifact_schema_version: string;
  readonly definition_id: string;
  readonly predecessor_id: string | null; readonly subject_id: string | null;
  readonly by_id?: string | null;
}
export interface CaptureEnvelope {
  readonly format: "observation.artifact-revision/v2"; readonly source: CaptureSource; readonly recorded_at: string;
  readonly body: JsonValue;
  readonly body_digest: CanonicalDigest;
}
export interface SessionSettingsWire { readonly harness: string; readonly model: string; readonly effort: string | null }
/** The exact config a run was launched with. `grading_enabled` is the run's automatic-grading choice. */
export interface RunConfigWire {
  readonly sessions: { readonly [stage: string]: { readonly [worker: string]: SessionSettingsWire } };
  readonly grading_enabled: boolean;
}
export interface SourceEventProvenance { readonly format: "observation.source-event/v1";
  readonly definition_id: string | null; readonly artifact_schema_version: string | null }
export type SourceEventOutcome = SourceEventProvenance & (
  | { readonly kind: "artifact_revision"; readonly event_kind: "revision_published"; readonly run_id: string; readonly event_id: string; readonly revision: CaptureEnvelope }
  | { readonly kind: "run_input"; readonly event_kind: "launched"; readonly run_id: string; readonly event_id: string; readonly input: unknown;
      readonly input_schema_version: string; readonly config: RunConfigWire | null }
  | { readonly kind: "ignored"; readonly event_kind: "operator_decided" | "worker_started" | "worker_ended" | "retry_requested" | "cancel_requested";
      readonly run_id: string; readonly event_id: string }
  /** A producer's explicit relations, carried as journaled: the service's profile reads them. */
  | { readonly kind: "relation_declaration"; readonly event_kind: string; readonly run_id: string; readonly event_id: string; readonly declaration: JsonValue }
  | { readonly kind: "unmapped"; readonly event_kind: string; readonly run_id: string; readonly event_id: string; readonly reason: string });
export interface SourceEventDelivery { readonly previous: SourceEventCursor; readonly cursor: SourceEventCursor; readonly outcome: SourceEventOutcome }
export interface SourceEventAck { readonly cursor: SourceEventCursor }
