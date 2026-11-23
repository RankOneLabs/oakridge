import { expect, test } from "vitest";
import { retryUnit, withUnitFields } from "../__fixtures__/read-models";
import type { OperatorAttemptView, OperatorOpenReview, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { artifactRevisionId, reviewToGates, selectReviewPullRequestUrl } from "./core";
import { classifyRunInbox } from "./inbox";
import { selectArtifactPageGates } from "../lib/artifact-page-gates";

const base = retryUnit("folio");
const reviewed = "manuscript:4";
const review: OperatorOpenReview = {
  review: "folio_desk", of_artifact: "manuscript", reviewed_revision_id: reviewed,
  producer_workers: ["scribe"], wait: "operator", confirms: null, failure_code: null,
  decisions: [
    { key: "accept_with_citation", label: "Accept with citation", effect: "approve", operation: "plain", on_artifact: "appendix", target_revision_id: "appendix:2" },
    { key: "accept_as_written", label: "Accept as written", effect: "approve", operation: "plain", on_artifact: "manuscript", target_revision_id: reviewed },
  ],
};
const body = { prose: "Opening" };
const manuscript: OperatorUnitView["artifacts"][number] = {
  run_id: base.run_id, unit_id: base.unit_id, artifact_key: "manuscript", view: null, kind: "document", schema: "draft_copy",
  is_reviewable: true, has_assessment_operations: false, is_editable: true, revision_count: 4,
  latest_revision: { id: reviewed, run_id: base.run_id, unit_id: base.unit_id, artifact_key: "manuscript", attempt_id: null,
    artifact_schema_version: null, predecessor_id: null, subject_id: null, number: 4, created_at: "2026-11-01", body },
};
const attempt = (worker: string, number: number): OperatorAttemptView => ({
  id: `${worker}:${number}`, unit_id: base.unit_id, worker, number, status: "succeeded",
  mode: "initial", cause: { kind: "missing" }, failure: null, is_current: true, created_at: "2026-11-01",
  intent: null, kbbl_session_id: "shared",
});
const input = withUnitFields(base, {
  stage: null,
  artifacts: [manuscript],
  attempts: [attempt("scribe", 1), attempt("reader", 1)],
  workers: [{ key: "scribe", label: "Scribe", kind: "agent" }, { key: "reader", label: "Reader", kind: "agent" }],
  reviews: [review, { ...review, review: "reading_desk", producer_workers: ["reader"] }],
  decisions: review.decisions.map((decision) => ({
    key: decision.key, label: decision.label, fields: [], payload_schema: "{}", operation: decision.operation, assessment: null,
    submit: { kind: "review", review: review.review, decision: decision.key, effect: decision.effect, target_revision_id: decision.target_revision_id },
  })),
});

test("the reviewed revision anchors redirected decisions and preserves their independent keys", () => {
  const gates = reviewToGates(input);
  if (!gates.ok) throw new Error(gates.error.detail);
  const page = selectArtifactPageGates({ gates: gates.value, revision_ids: new Set([artifactRevisionId(manuscript, reviewed)]) });
  expect(page.artifactGate).toMatchObject({
    reviewed_revision_id: reviewed, resume_actions: ["accept_with_citation", "accept_as_written"], producer_labels: ["Scribe"],
  });
});

test("two producers sharing a session host both reviews there, including a unit without a stage", () => {
  const gates = reviewToGates(input);
  if (!gates.ok) throw new Error(gates.error.detail);
  expect(gates.value.map(({ session_id, stage_name }) => [session_id, stage_name])).toEqual([
    ["shared", input.label], ["shared", input.label],
  ]);
});

test.each(["design", "expand", "freeze"])("a %s merge gate reads the declared link field from its reviewed artifact", (stage) => {
  const url = "https://github.com/acme/sample/pull/13";
  const artifact = { ...manuscript, kind: "external_reference" as const, link_field: "review_link",
    latest_revision: { ...manuscript.latest_revision!, body: { review_link: url } } };
  const merge = { ...review, confirms: "merge" as const, wait: "external" as const };
  const unit = withUnitFields(input, { stage, artifacts: [artifact], reviews: [merge] });
  expect(selectReviewPullRequestUrl(unit, merge)).toBe(url);
  const gates = reviewToGates(unit);
  expect(gates.ok && gates.value[0].gate_type).toBe("merge");
});


test("the attention list uses a unit label when the stage is absent", () => {
  const stalled = withUnitFields(input, { decisions: [], attempts: [], attention: { kind: "stalled", detail: "Needs attention", failure_code: null } });
  const result = classifyRunInbox({ run_id: stalled.run_id, items: [{
    kind: "stalled", run_id: stalled.run_id, unit_id: stalled.unit_id, detail: "Needs attention", failure_code: null,
  }] }, [stalled], { workflow_name: "folio", run_title: null });
  expect(result.ok && result.value.items[0]?.stage_name).toBe(stalled.label);
});
