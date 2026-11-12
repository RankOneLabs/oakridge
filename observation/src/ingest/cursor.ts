import type { JsonValue } from "../domain/primitives";
import { decodeCapture, type CaptureEnvelope } from "./capture";

/** The producer's durable position in authority.event, represented as decimal text to avoid bigint precision loss. */
export interface SourceEventCursor { readonly commit_txid: string; readonly id: string }
export const INITIAL_SOURCE_CURSOR: SourceEventCursor = { commit_txid: "0", id: "" };

export interface SessionSettingsWire { readonly harness: string; readonly model: string; readonly effort: string | null }
/** The exact config a run was launched with, carried beside its input. Only `grading_enabled` is
 * read here: it is the run's own automatic-grading choice, and null means the launch made none. */
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
  /** A producer's explicit relations, carried as journaled: the injected profile reads them. */
  | { readonly kind: "relation_declaration"; readonly event_kind: string; readonly run_id: string; readonly event_id: string; readonly declaration: JsonValue }
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
/** A launch carries its committed config, or null when it supplied none. */
function runConfig(value: unknown): value is RunConfigWire | null {
  return value === null || (record(value) && typeof value.grading_enabled === "boolean" && record(value.sessions));
}
export function decodeSourceEventDelivery(value: unknown): SourceEventDelivery | null {
  if (!record(value) || !cursor(value.previous) || !cursor(value.cursor) || !record(value.outcome)) return null;
  const outcome = value.outcome;
  if (typeof outcome.kind !== "string" || typeof outcome.event_kind !== "string" || typeof outcome.run_id !== "string"
    || typeof outcome.event_id !== "string" || outcome.event_id !== value.cursor.id) return null;
  if (outcome.format !== "observation.source-event/v1" || !(outcome.artifact_schema_version === null || typeof outcome.artifact_schema_version === "string")) return null;
  if (!(outcome.definition_id === null || typeof outcome.definition_id === "string")) return null;
  if (outcome.kind === "artifact_revision" && !decodeCapture(outcome.revision).ok) return null;
  if (outcome.kind === "unmapped" && typeof outcome.reason !== "string") return null;
  if (outcome.kind === "run_input" && !runConfig(outcome.config)) return null;
  if (outcome.kind === "relation_declaration" && !record(outcome.declaration)) return null;
  if (!["artifact_revision", "run_input", "ignored", "relation_declaration", "unmapped"].includes(outcome.kind)) return null;
  return value as unknown as SourceEventDelivery;
}
