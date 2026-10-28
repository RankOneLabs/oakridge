import { expect, test } from "bun:test";
import { prepareRows, type ExportRows } from "../src/storage/export-store";
import type { RedactionPolicy } from "../src/export/manifest";

const tenant = { producer: "oakridge", namespace: "redaction-test" };
const selection = { run_id: null, occurrence_ids: null };
const identity = { manifest_id: "redaction", frozen_at: "2026-01-01T00:00:00.000Z" };
const fixture = {
  revisions: [{ ...tenant, revision_id: "rev", artifact_kind: "build_result", body_digest:
    "canonical-json/v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  body: { output: "PRIVATE BUILD", tests: { cargo_test_output: "PRIVATE TEST" }, repository_snapshot: "PRIVATE SOURCE" } }],
  occurrences: [{ ...tenant, occurrence_id: "occ", revision_id: "rev", run_id: "run", item_selector: "/build_result",
    selected_value: { output: "PRIVATE BUILD", tests: { cargo_test_output: "PRIVATE TEST" }, repository_snapshot: "PRIVATE SOURCE" } }],
  evidences: [{ ...tenant, evidence_set_id: "evidence", evidence_refs: [], is_incomplete: false, incompleteness_reason: null }],
  grades: [{ ...tenant, observation_id: "grade", execution_id: "exec", subject_occurrence_id: "occ", evidence_set_id: "evidence",
    question_id: "q", question_version: "1", evaluator_definition_id: "human", answer_state: "answered", answer_payload: {} }],
  executions: [{ ...tenant, execution_id: "exec", question_id: "q", evaluator_definition_id: "human" }],
  evaluators: [{ ...tenant, evaluator_definition_id: "human", kind: "human", identity_digest: "digest" }],
  questions: [{ ...tenant, question_id: "q", question_version: "1", input_recipe: {}, response_kind: "boolean" }],
} as unknown as ExportRows;

test("raw build, test, and repository values are withheld and each omission is explained", () => {
  const policy: RedactionPolicy = { target_name: "assay", allow_raw_build_output: false, allow_raw_test_output: false, allow_repository_content: false };
  const prepared = prepareRows(fixture, tenant, selection, policy, identity);
  const serialized = JSON.stringify(prepared.records);
  for (const secret of ["PRIVATE BUILD", "PRIVATE TEST", "PRIVATE SOURCE"]) expect(serialized).not.toContain(secret);
  expect(new Set(prepared.manifest.membership[0]?.redaction_reasons.map((reason) => reason.reason)))
    .toEqual(new Set(["raw_build_output", "raw_test_output", "repository_content"]));
});

test("the target can explicitly allow all three raw content classes", () => {
  const policy: RedactionPolicy = { target_name: "assay", allow_raw_build_output: true, allow_raw_test_output: true, allow_repository_content: true };
  const prepared = prepareRows(fixture, tenant, selection, policy, identity);
  const serialized = JSON.stringify(prepared.records);
  for (const secret of ["PRIVATE BUILD", "PRIVATE TEST", "PRIVATE SOURCE"]) expect(serialized).toContain(secret);
  expect(prepared.manifest.membership[0]?.redaction_reasons).toEqual([]);
});
