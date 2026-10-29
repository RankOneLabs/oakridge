import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { CanonicalDigest } from "../domain/identity";
import type { LangfuseError, LangfuseObservationId, LangfuseTraceId } from "../ports/evaluation-backend";
import type { ProjectionShape } from "./projection";

export interface OtlpTargetIds {
  readonly trace_id: LangfuseTraceId;
  readonly observation_id: LangfuseObservationId;
}
export interface OtlpSpanTiming { readonly started_at: Date; readonly ended_at: Date | null }
type OtlpAttribute = { readonly key: string; readonly value: { readonly stringValue: string } };

/** A mapping key's digest fixes its trace and span IDs, so a replay addresses the same target. */
export function otlpTargetIds(mapping_key: CanonicalDigest): Result<OtlpTargetIds, LangfuseError> {
  const hex = /^canonical-json\/v1:([0-9a-f]{64})$/.exec(mapping_key)?.[1];
  if (!hex) return err({ operation: "otlp_target_ids", entity_id: mapping_key, detail: "mapping key is not a canonical digest" });
  return ok({ trace_id: hex.slice(0, 32) as LangfuseTraceId, observation_id: hex.slice(32, 48) as LangfuseObservationId });
}

function attribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}
function nanoseconds(at: Date): string {
  return (BigInt(at.getTime()) * 1_000_000n).toString();
}

/** One root span per projection; times come from the execution, never the clock. */
export function encodeOtlpTrace(shape: ProjectionShape, ids: OtlpTargetIds, timing: OtlpSpanTiming): JsonValue {
  const end = timing.ended_at && timing.ended_at >= timing.started_at ? timing.ended_at
    : new Date(timing.started_at.getTime() + 1);
  const metadata = Object.entries(shape.trace.metadata).map(([key, value]) =>
    attribute(`langfuse.trace.metadata.${key}`, String(value)));
  return { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: String(ids.trace_id), spanId: String(ids.observation_id),
    name: shape.observation.name, startTimeUnixNano: nanoseconds(timing.started_at), endTimeUnixNano: nanoseconds(end),
    attributes: [attribute("langfuse.trace.name", shape.observation.name),
      attribute("langfuse.observation.input", JSON.stringify(shape.observation.input)),
      attribute("langfuse.observation.output", JSON.stringify(shape.observation.output)), ...metadata] }] }] }] };
}
