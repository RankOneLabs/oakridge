import { expect, test } from "bun:test";
import type { EvidenceSetId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import type { EvidenceSet } from "../src/grading/evidence";
import { evidenceSetDigest, mappingKey, type MappingKeyInput } from "../src/langfuse/mapping";

const evidence: EvidenceSet = { evidence_set_id: "evidence-1" as EvidenceSetId,
  references: [{ ref: "artifact:brief", kind: "public", content: "first body", digest: null }],
  is_incomplete: false, incompleteness_reason: null };
const identity: MappingKeyInput = { occurrence_id: "occurrence-1" as ItemOccurrenceId, evidence,
  question_id: "question-a" as QuestionId, question_version: "1", projection_version: "1" };
function key(input: MappingKeyInput): string {
  const result = mappingKey(input);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value.mapping_key;
}

test("questions sharing one evidence set have distinct mapping keys", () => {
  expect(key(identity)).not.toBe(key({ ...identity, question_id: "question-b" as QuestionId }));
});

test("a changed evidence reference changes the key while evidence_set_id stays fixed", () => {
  const changed: EvidenceSet = { ...evidence, references: [{ ...evidence.references[0]!, content: "revised body" }] };
  expect(changed.evidence_set_id).toBe(evidence.evidence_set_id);
  expect(key({ ...identity, evidence: changed })).not.toBe(key(identity));
});

test("evidence digest mirrors the export contract and excludes evidence_set_id", () => {
  const renamed: EvidenceSet = { ...evidence, evidence_set_id: "evidence-2" as EvidenceSetId };
  expect(evidenceSetDigest(renamed)).toEqual(evidenceSetDigest(evidence));
  expect(key({ ...identity, evidence: renamed })).toBe(key(identity));
});

test("a shape version bump creates a new key without changing the old key", () => {
  const before = key(identity);
  expect(key({ ...identity, projection_version: "2" })).not.toBe(before);
  expect(key(identity)).toBe(before);
  expect(before).toMatch(/^canonical-json\/v1:[0-9a-f]{64}$/);
});
