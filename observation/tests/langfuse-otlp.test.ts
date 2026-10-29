import { expect, test } from "bun:test";
import type { CanonicalDigest } from "../src/domain/identity";
import { encodeOtlpTrace, otlpTargetIds } from "../src/langfuse/otlp";
import type { ProjectionShape } from "../src/langfuse/projection";

const key = `canonical-json/v1:${"0123456789abcdef".repeat(4)}` as unknown as CanonicalDigest;
const shape = { trace: { metadata: { producer: "oakridge", question_id: "plan.criterion_traceability" } },
  observation: { name: "plan.criterion_traceability@v1", input: { question_text: "Q" }, output: { status: "completed" } },
  score_name: "plan.criterion_traceability@v1" } as unknown as ProjectionShape;

test("trace and span IDs are fixed by the mapping key digest", () => {
  const ids = otlpTargetIds(key);
  expect(ids.ok && [String(ids.value.trace_id), String(ids.value.observation_id)])
    .toEqual(["0123456789abcdef0123456789abcdef", "0123456789abcdef"]);
  expect(otlpTargetIds("not-a-digest" as CanonicalDigest).ok).toBe(false);
});

test("the span carries JSON input and output, flattened trace metadata, and the execution's own times", () => {
  const ids = otlpTargetIds(key);
  if (!ids.ok) throw new Error(ids.error.detail);
  const body = encodeOtlpTrace(shape, ids.value, { started_at: new Date(1_000), ended_at: null }) as {
    resourceSpans: { scopeSpans: { spans: { startTimeUnixNano: string; endTimeUnixNano: string;
      attributes: { key: string; value: { stringValue: string } }[] }[] }[] }[] };
  const span = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  const attributes = Object.fromEntries(span.attributes.map((item) => [item.key, item.value.stringValue]));
  expect(attributes).toEqual({ "langfuse.trace.name": "plan.criterion_traceability@v1",
    "langfuse.observation.input": JSON.stringify({ question_text: "Q" }),
    "langfuse.observation.output": JSON.stringify({ status: "completed" }),
    "langfuse.trace.metadata.producer": "oakridge",
    "langfuse.trace.metadata.question_id": "plan.criterion_traceability" });
  expect([span.startTimeUnixNano, span.endTimeUnixNano]).toEqual(["1000000000", "1001000000"]);
});
