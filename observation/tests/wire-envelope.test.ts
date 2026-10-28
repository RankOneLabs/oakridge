import { expect, test } from "bun:test";
import type { ArtifactRevisionEnvelope, EvidenceSetEnvelope, ExecutionEnvelope, GradeObservationEnvelope, ItemOccurrenceEnvelope, ObservationEnvelope, QuestionEnvelope, RelationEnvelope } from "../src/wire/envelope";

type Formats = ObservationEnvelope["format"];
type ExpectedFormats =
  | "observation.artifact-revision/v1" | "observation.item/v1" | "observation.relation/v1"
  | "observation.evidence-set/v1" | "observation.question/v1" | "observation.execution/v1" | "observation.grade/v1";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const allFormatsArePinned: Equal<Formats, ExpectedFormats> = true;

type Kinds<T extends ObservationEnvelope> = T["kind"];
const variantCounts: readonly [Kinds<ArtifactRevisionEnvelope>, Kinds<ItemOccurrenceEnvelope>, Kinds<RelationEnvelope>, Kinds<EvidenceSetEnvelope>, Kinds<QuestionEnvelope>, Kinds<ExecutionEnvelope>, Kinds<GradeObservationEnvelope>] =
  ["structured", "stable-id", "trace", "context", "choice", "requested", "evaluator"];

test("all seven envelopes have pinned formats and discriminated payload variants", () => {
  expect(allFormatsArePinned).toBe(true);
  expect(variantCounts).toHaveLength(7);
});

// @ts-expect-error Every variant must carry its format discriminant.
const untagged: ArtifactRevisionEnvelope = { kind: "text", payload: { body: "" } };
void untagged;
