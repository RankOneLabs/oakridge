import { expect, test } from "bun:test";
import type { Stage } from "../src/core-client/core-types";
import type { UnitAttention } from "../src/projections/attention";
import { selectAvailableDecisions } from "../src/projections/unit-view";
import type { RunSummaryRead, UnitSummaryRecord } from "../src/storage/read-store";

/** A cohort stage whose assessment review may instead request changes `on` the build. */
const stage = {
  input: {}, outcome: {}, workers: {}, artifacts: { assessment: { schema: "text" }, build_result: { schema: "text" } },
  reviews: { assessment_review: { of: "assessment", by: "operator", decisions: {
    accept: { effect: "approve", label: "Accept" },
    request_build_changes: { effect: "request_changes", on: "build_result", label: "Request build changes" } } } },
} as unknown as Stage;
const unit = { id: "run/cohort", parent_id: "run", declaration: "cohort", stage: "cohort" } as UnitSummaryRecord;
// The read's own revisions name a newer build than the core resolved: the view must not re-derive the target from them.
const read = { run: { status: { kind: "active" } }, definition: { workflow: { stages: { cohort: stage } } },
  revisions: [{ id: "run/cohort:build_result:9", unit_id: unit.id, artifact: "build_result" }] } as unknown as RunSummaryRead;
const awaiting = (decisions: UnitAttention["awaiting"][number]["decisions"]): UnitAttention => ({ unit_id: unit.id, run_stalls: [], stalled: [],
  blocked: null, awaiting: [{ unit_id: unit.id, review: "assessment_review", target: "run/cohort:assessment:1", decisions, prompt: "" }] });
const targetsOf = (attention: UnitAttention) => selectAvailableDecisions(read, unit, attention)
  .map((decision) => decision.submit.kind === "review" ? [decision.submit.decision, decision.submit.target_revision_id] : [decision.key]);

test("each review decision submits the target the core resolved for it", () => {
  expect(targetsOf(awaiting([{ decision: "accept", target: "run/cohort:assessment:1" },
    { decision: "request_build_changes", target: "run/cohort:build_result:2" }])))
    .toEqual([["accept", "run/cohort:assessment:1"], ["request_build_changes", "run/cohort:build_result:2"]]);
});

test("a decision the core does not list is not offered", () => {
  expect(targetsOf(awaiting([{ decision: "accept", target: "run/cohort:assessment:1" }]))).toEqual([["accept", "run/cohort:assessment:1"]]);
});
