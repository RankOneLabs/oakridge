import { expect, test } from "vitest";
import snapshot from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectEffectiveWorkers, selectEffectiveReviews } from "./effective-declarations";
const detail = snapshot.definition as unknown as OperatorDefinitionDetail;
const workers = selectEffectiveWorkers(detail);
const reviews = selectEffectiveReviews(detail);

test.each(["cohort", "integration"])("%s pr_watch is expanded with template provenance", (stage) => {
  expect(workers.find((worker) => worker.stage === stage && worker.key === "pr_watch")).toMatchObject({ source: { template: "pr_watch" }, worker: { kind: "code", operation: "pull_request.observe", when: "pr_published", every: "2m", produces: ["pr_state"] } });
});
test.each([["cohort", "build_result"], ["integration", "pr"]])("%s pr_closed retains its overridden target", (stage, of) => {
  expect(reviews.find((review) => review.stage === stage && review.key === "pr_closed")).toMatchObject({ source: { template: "pr_closed" }, review: { of, by: "operator", when: "closed_pr" }, decisions: [{ key: "replace_pr", decision: { effect: "request_changes", label: "Replace the closed PR" } }] });
});
test("decision set expansion retains provenance and overrides", () => {
  const analysis = reviews.find((review) => review.key === "analysis_review");
  expect(analysis?.decisions).toMatchObject([
    { key: "accept", decision: { effect: "approve", label: "Accept" }, source: { set: "accept_or_request", overrides: null, rename: null } },
    { key: "request_changes", decision: { effect: "request_changes", label: "Request changes" }, source: { set: "accept_or_request", overrides: null, rename: null } },
  ]);
  const plan = reviews.find((review) => review.key === "plan_review");
  expect(plan?.decisions.find((decision) => decision.key === "request_changes")).toMatchObject({ decision: { fields: { feedback: "What must the plan change?" } }, source: { set: "accept_or_request", overrides: { request_changes: { fields: { feedback: "What must the plan change?" } } }, rename: null } });
});
test("inline assessment decisions have no template or set provenance", () => {
  const assessment = reviews.find((review) => review.key === "assessment_review");
  expect(assessment?.source).toBeNull();
  expect(assessment?.decisions.map((decision) => decision.source)).toEqual([null, null, null]);
});
