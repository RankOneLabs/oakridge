import { describe, expect, it } from "vitest";
import sample from "../__fixtures__/v2-adapter-sample.json";
import cohortMerge from "../__fixtures__/v2-cohort-merge.json";
import integrationMerge from "../__fixtures__/v2-integration-merge.json";
import { projectedReview, sampleCohort as cohort, sampleRun as run, sampleUnits as units, withUnitFields } from "../__fixtures__/read-models";
import type { OperatorRunInboxBatchEntry } from "../operator-contracts/projections/inbox";
import type { OperatorDecisionDefinition, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { artifactRevisionId, objectValue, repositoryKeyOf, reviewToGates } from "./core";
import { classifyRunInbox, replaceInboxRun } from "./inbox";
import { selectOpenBlockerGate } from "./gates";
import parkedBlocker from "../__fixtures__/parked-blocker-unit.json";

describe("development inbox", () => {
  it("classifies a development workflow inbox with a cohort lifecycle", () => {
    const inbox = classifyRunInbox(sample.inbox as unknown as { run_id: string; items: readonly import("../operator-contracts/projections/inbox").OperatorInboxItem[] }, units, { workflow_name: "development", run_title: null });
    expect(inbox.ok && [inbox.value.items[0].kind, inbox.value.cohorts.find((item) => item.stage_name === "cohort" && item.unit_id === cohort.collection_key)?.lifecycle]).toEqual(["artifact_gate", "artifact_review"]);
    expect(inbox.ok && inbox.value.items.filter((item) => item.kind === "artifact_gate")).toHaveLength(1);
    expect(inbox.ok && inbox.value.items[0].resume_actions).toEqual(["accept", "request_build_changes"]);
  });
  it("labels two repositories and every stage from the captured multi-cohort run", () => {
    const second = units.find((unit) => unit.stage === "cohort" && unit.collection_key === "b");
    const analysis = units.find((unit) => unit.stage === "analysis");
    const planning = units.find((unit) => unit.stage === "planning");
    const brief = units.find((unit) => unit.stage === "brief" && unit.collection_key === "a");
    const prepare = units.find((unit) => unit.stage === "prepare");
    const integration = (integrationMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.stage === "integration");
    if (!second || !analysis || !planning || !brief || !prepare || !integration) throw new Error("captured fixtures lack development stages");
    const secondInDocs = withUnitFields(second, { input: { ...objectValue(second.input), repository: { key: "docs" } } });
    const planningWithKey = withUnitFields(planning, { input: { ...objectValue(planning.input), repository_key: "app" } });
    const runUnits = units.map((unit) => unit.unit_id === second.unit_id ? secondInDocs
      : unit.unit_id === planning.unit_id ? planningWithKey : unit);
    const entry: OperatorRunInboxBatchEntry = { run_id: run.run_id, items: [
      ...sample.inbox.items as OperatorRunInboxBatchEntry["items"],
      { kind: "waiting", run_id: run.run_id, unit_id: analysis.unit_id, reason: "awaiting prerequisite", label: "Awaiting prerequisite" },
      { kind: "waiting", run_id: run.run_id, unit_id: planning.unit_id, reason: "awaiting prerequisite", label: "Awaiting prerequisite" },
      { kind: "waiting", run_id: run.run_id, unit_id: brief.unit_id, reason: "awaiting prerequisite", label: "Awaiting prerequisite" },
    ] };
    const result = classifyRunInbox(entry, runUnits, { workflow_name: "development", run_title: "Ship Oakridge" });
    if (!result.ok) throw new Error(result.error.detail);
    const firstItem = result.value.items.find((item) => item.unit_id === "a");
    const secondItem = result.value.items.find((item) => item.unit_id === "b");
    const analysisItem = result.value.items.find((item) => item.stage_name === "analysis");
    const planningItem = result.value.items.find((item) => item.stage_name === "planning");
    const briefItem = result.value.items.find((item) => item.stage_name === "brief" && item.unit_id === "a");
    expect([firstItem?.title, secondItem?.title, secondItem?.blocked_by.includes("a · Cohort · app"), analysisItem?.title])
      .toEqual(["a · Cohort · app", "b · Cohort · docs", true, "Analysis"]);
    expect(result.value.cohorts.filter((item) => item.stage_name === "cohort").map((item) => [item.title, item.repository_key]))
      .toEqual([["a · Cohort · app", "app"], ["b · Cohort · docs", "docs"]]);
    expect(briefItem?.title).toBe("a · Brief · app");
    expect([repositoryKeyOf(analysis), repositoryKeyOf(planningWithKey), repositoryKeyOf(brief), repositoryKeyOf(cohort),
      repositoryKeyOf(prepare), repositoryKeyOf(integration), analysisItem?.repository_key, planningItem?.repository_key])
      .toEqual([null, "app", "app", "app", "app", "app", null, "app"]);
  });
  it("keeps inbox work and other cohort summaries when one repository input is missing", () => {
    const withoutRepository = withUnitFields(cohort, { input: {} });
    const other = units.find((unit) => unit.stage === "cohort" && unit.unit_id !== cohort.unit_id);
    if (!other) throw new Error("captured fixture lacks another cohort");
    const result = classifyRunInbox({ run_id: run.run_id, items: [
      { kind: "waiting", run_id: run.run_id, unit_id: cohort.unit_id, reason: "awaiting prerequisite", label: "Awaiting prerequisite" },
    ] }, [withoutRepository, other], { workflow_name: "development", run_title: null });
    expect(result.ok && [result.value.cohorts.map((summary) => summary.unit_id), result.value.items[0]?.repository_key])
      .toEqual([[other.collection_key], null]);
  });
  it("lists a parked blocker once, as a blocker item that opens its unit", () => {
    const blocked = parkedBlocker as unknown as OperatorUnitView;
    const result = classifyRunInbox({ run_id: blocked.run_id, items: [
      ...blocked.decisions.map((decision) => ({ kind: "decision" as const, run_id: blocked.run_id, unit_id: blocked.unit_id, key: decision.key, label: decision.label, submit: decision.submit, prompt: null })),
      { kind: "waiting" as const, run_id: blocked.run_id, unit_id: blocked.unit_id, reason: "worker blocked: needs an operator answer", label: blocked.label },
    ] }, [blocked], { workflow_name: "development", run_title: null });
    expect(result.ok && result.value.items.map((item) => [item.kind, item.run_unit_id])).toEqual([["blocker", blocked.unit_id]]);
  });
  it("finds a unit's open blocker gate, and none once it is answered", () => {
    const blocked = parkedBlocker as unknown as OperatorUnitView;
    const answered = { ...blocked, blocker: blocked.blocker ? { ...blocked.blocker, is_open: false } : null };
    expect([selectOpenBlockerGate(blocked)?.gate_step, selectOpenBlockerGate(answered)]).toEqual(["blocker_review", null]);
  });
  it("uses the projected label for a blocking upstream unit", () => {
    const analysis = units.find((unit) => unit.stage === "analysis");
    if (!analysis) throw new Error("captured fixture lacks an analysis unit");
    const blocked = withUnitFields(cohort, { depends_on: [analysis.unit_id] });
    const result = classifyRunInbox({ run_id: run.run_id, items: [
      { kind: "waiting", run_id: run.run_id, unit_id: blocked.unit_id, reason: "awaiting prerequisite", label: "Awaiting prerequisite" },
    ] }, [blocked, analysis], { workflow_name: "development", run_title: null });
    expect(result.ok && result.value.items[0]?.blocked_by).toEqual([analysis.label]);
  });
  it("shows one recovery item per failed brief when each has a retry and a stalled diagnostic", () => {
    const briefUnits = ["first", "second"].map((name) => withUnitFields(cohort, {
      unit_id: `${run.run_id}/briefs/${name}`, unit_key: name, collection_key: name,
      label: `Brief ${name}`, stage: "brief", decisions: [], artifacts: [],
    }));
    const entry: OperatorRunInboxBatchEntry = { run_id: run.run_id, items: briefUnits.flatMap((unit) => [
      { kind: "decision" as const, run_id: run.run_id, unit_id: unit.unit_id, key: "retry:writer",
        label: "Retry Writer", submit: { kind: "retry" as const, worker: "writer" }, prompt: null },
      { kind: "stalled" as const, failure_code: null, run_id: run.run_id, unit_id: unit.unit_id, detail: "writer failed" },
    ]) };
    const inbox = classifyRunInbox(entry, briefUnits, { workflow_name: "development", run_title: null });
    expect(inbox.ok && inbox.value.items.map((item) => item.unit_id)).toEqual(["first", "second"]);
  });
  it("keeps the manual merge action as the only inbox row when the optional PR watcher fails", () => {
    const mergeUnit = (cohortMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.decisions.some((decision) => decision.submit.kind === "review"
      && decision.submit.decision === "confirm_merged"));
    if (!mergeUnit) throw new Error("captured fixture lacks merge confirmation");
    const observation = mergeUnit.artifacts.find((artifact) => artifact.artifact_key === "pr_state");
    const confirm = mergeUnit.decisions.find((decision) => decision.submit.kind === "review" && decision.submit.decision === "confirm_merged");
    if (!observation || !confirm || confirm.submit.kind !== "review") throw new Error("captured fixture lacks PR evidence");
    const stalled = withUnitFields(mergeUnit, {
      artifacts: [...mergeUnit.artifacts, { ...observation, artifact_key: "observed_state" }],
      attention: { kind: "stalled", failure_code: "discovery_unsupported", detail: "No pull request reader is configured" },
      attempts: mergeUnit.attempts.map((attempt) => attempt.worker === "pr_watch"
        ? { ...attempt, status: "failed", failure: { code: "discovery_unsupported", detail: "no pull request reader is configured" } }
        : attempt) });
    const entry: OperatorRunInboxBatchEntry = { run_id: stalled.run_id, items: [
      { kind: "decision", run_id: stalled.run_id, unit_id: stalled.unit_id, key: confirm.key,
        label: confirm.label, submit: confirm.submit, prompt: null },
      { kind: "decision", run_id: stalled.run_id, unit_id: stalled.unit_id, key: "retry:pr_watch",
        label: "Retry PR watch", submit: { kind: "retry", worker: "pr_watch" }, prompt: null },
      { kind: "stalled", failure_code: "discovery_unsupported", run_id: stalled.run_id, unit_id: stalled.unit_id,
        detail: "No pull request reader is configured" },
    ] };
    const inbox = classifyRunInbox(entry, [stalled], { workflow_name: "development", run_title: null });
    expect(inbox.ok && [inbox.value.items.map((item) => item.kind), inbox.value.cohorts[0]?.lifecycle])
      .toEqual([["merge_review"], "merge_review"]);
    expect(inbox.ok && inbox.value.items[0]?.pr_url).toBe("https://github.com/oakridge-e2e/app/pull/1");
    const gates = reviewToGates(stalled);
    expect(gates.ok && gates.value[0]).toMatchObject({ pr_url: "https://github.com/oakridge-e2e/app/pull/1", assessment_revision_id: null });
  });
  it("keeps both run slices when invalidate responses complete against an old inbox snapshot", () => {
    const first = classifyRunInbox(sample.inbox as unknown as { run_id: string; items: readonly import("../operator-contracts/projections/inbox").OperatorInboxItem[] }, units, { workflow_name: "development", run_title: null });
    if (!first.ok) throw new Error(first.error.detail);
    const secondRun = "run-another";
    const second = { cohorts: first.value.cohorts.map((cohort) => ({ ...cohort, run_id: secondRun })),
      items: first.value.items.map((item) => ({ ...item, run_id: secondRun })) };
    const latest = replaceInboxRun(first.value, secondRun, second);
    const changedFirst = { cohorts: first.value.cohorts, items: [] };
    const combined = replaceInboxRun(latest, run.run_id, changedFirst);
    expect([combined.items.some((item) => item.run_id === run.run_id), combined.items.some((item) => item.run_id === secondRun)])
      .toEqual([false, true]);
  });
  it("labels integration review work with the assessment it asks the operator to judge", () => {
    const integration = (integrationMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.stage === "integration");
    if (!integration) throw new Error("captured fixture lacks an integration unit");
    const source = cohort.artifacts.find(artifact => artifact.artifact_key === "assessment");
    if (!source?.latest_revision) throw new Error("captured fixture lacks assessment");
    const assessment = { ...source, run_id: integration.run_id, unit_id: integration.unit_id,
      latest_revision: { ...source.latest_revision, id: "integration-assessment:2", run_id: integration.run_id, unit_id: integration.unit_id } };
    const adjudicated = withUnitFields(integration, { artifacts: [...integration.artifacts, assessment], decisions: integration.decisions.map(decision =>
      decision.submit.kind === "review" && decision.submit.review === "integration_review"
        ? { ...decision, operation: decision.submit.effect === "approve" ? "approve_assessment" : "dispatch_feedback", assessment: assessment.artifact_key }
        : decision) });
    const items = adjudicated.decisions.flatMap((decision) => decision.submit.kind === "review" ? [{ kind: "decision" as const,
      run_id: integration.run_id, unit_id: integration.unit_id, key: decision.key, label: decision.label, submit: decision.submit, prompt: null }] : []);
    const result = classifyRunInbox({ run_id: integration.run_id, items }, [adjudicated], { workflow_name: "development", run_title: null });
    expect(result.ok && result.value.items).toMatchObject([
      { kind: "artifact_gate", artifact_key: "assessment", artifact_revision_id: artifactRevisionId(assessment, assessment.latest_revision.id),
        requires_adjudication: true, resume_actions: [] },
      { kind: "merge_review", artifact_key: "pr_state", requires_adjudication: false },
    ]);
  });
});

describe("study inbox", () => {
  const revision = cohort.artifacts.find((artifact) => artifact.artifact_key === "assessment")?.latest_revision;
  if (!revision) throw new Error("captured fixture lacks an artifact revision");

  const approve: OperatorDecisionDefinition = {
    key: "approve", label: "Approve", fields: [], payload_schema: "{}", operation: "plain", assessment: null,
    submit: { kind: "review", review: "report_review", decision: "approve", effect: "approve", target_revision_id: revision.id },
  };
  const requestChanges: OperatorDecisionDefinition = {
    key: "request_changes", label: "Request changes", fields: [{ key: "feedback", label: "What needs to change?" }],
    payload_schema: "{feedback: text}", operation: "plain", assessment: null,
    submit: { kind: "review", review: "report_review", decision: "request_changes", effect: "request_changes", target_revision_id: revision.id },
  };
  const unit = withUnitFields(cohort, {
    stage: "synthesis", collection_key: null, unit_key: "synthesis",
    decisions: [approve, requestChanges], reviews: [projectedReview({ review: "report_review", of_artifact: "assessment", reviewed_revision_id: revision.id }, [approve, requestChanges])], input: { repository_key: "oakridge" },
  });
  const entry: OperatorRunInboxBatchEntry = { run_id: unit.run_id, items: [
    { kind: "decision", run_id: unit.run_id, unit_id: unit.unit_id, key: approve.key,
      label: approve.label, submit: approve.submit, prompt: null },
  ] };

  it("carries the study workflow name and title to every item", () => {
    const inbox = classifyRunInbox(entry, [unit], { workflow_name: "study", run_title: "Study run" });
    if (!inbox.ok) throw new Error(inbox.error.detail);
    expect(inbox.value.items.map(({ workflow_name, run_title }) => [workflow_name, run_title])).toEqual([["study", "Study run"]]);
  });

  it("offers both decisions for a review targeting the unit's latest artifact revision", () => {
    const inbox = classifyRunInbox(entry, [unit], { workflow_name: "study", run_title: null });
    if (!inbox.ok) throw new Error(inbox.error.detail);
    expect(inbox.value.items).toHaveLength(1);
    expect(inbox.value.items[0]).toMatchObject({
      kind: "artifact_gate", workflow_name: "study",
      gate_id: expect.any(String), artifact_revision_id: expect.any(String),
      resume_actions: ["approve", "request_changes"],
    });
  });

  it("keeps each request-changes decision distinct when a review offers several", () => {
    const sendBack = (decision: string): OperatorDecisionDefinition => ({ ...requestChanges, key: decision, label: decision,
      submit: { kind: "review", review: "report_review", decision, effect: "request_changes", target_revision_id: revision.id } });
    const sliceReview = withUnitFields(unit, { decisions: [approve, sendBack("send_to_builder"), sendBack("change_design")] });
    const inbox = classifyRunInbox(entry, [sliceReview], { workflow_name: "study", run_title: null });
    if (!inbox.ok) throw new Error(inbox.error.detail);
    expect(inbox.value.items[0]?.resume_actions).toEqual(["approve", "send_to_builder", "change_design"]);
  });

  it("marks a review whose decisions declare adjudication roles as needing adjudication", () => {
    const adjudicated = withUnitFields(unit, { decisions: [{ ...approve, operation: "approve_assessment", assessment: "assessment" }, { ...requestChanges, operation: "dispatch_feedback", assessment: "assessment" }] });
    const inbox = classifyRunInbox(entry, [adjudicated], { workflow_name: "study", run_title: null });
    if (!inbox.ok) throw new Error(inbox.error.detail);
    expect(inbox.value.items[0]?.requires_adjudication).toBe(true);
  });

  it("carries the validator's message when it rejected a revision the review decides", () => {
    const rejected = withUnitFields(unit, { decisions: [approve, requestChanges].map((decision) => ({ ...decision, payload_schema: "adjudication" })),
      recorded_decisions: [{ id: "v1", decision_id: "v1", actor: null, reviewed_revision_id: revision.id, approved_assessment_revision_id: null, effect_target_revision_id: revision.id, review: "engine:validator", decision: "request_changes", effect: "request_changes", target_revision_id: revision.id,
        payload: { feedback: "Assessment verdict must match item statuses and additional finding severities." }, created_at: "2026-11-20T00:00:00Z" }] });
    const inbox = classifyRunInbox(entry, [rejected], { workflow_name: "study", run_title: null });
    if (!inbox.ok) throw new Error(inbox.error.detail);
    expect(inbox.value.items[0]?.validation_rejection).toBe("Assessment verdict must match item statuses and additional finding severities.");
  });

  it("leaves a review with plain payloads deciding from the inbox", () => {
    const inbox = classifyRunInbox(entry, [unit], { workflow_name: "study", run_title: null });
    if (!inbox.ok) throw new Error(inbox.error.detail);
    expect(inbox.value.items[0]).toMatchObject({ requires_adjudication: false, artifact_key: "assessment" });
  });

  it("keeps a review with no matching artifact revision as a gate decision", () => {
    const withoutTarget = withUnitFields(unit, { artifacts: unit.artifacts.filter((artifact) => artifact.latest_revision?.id !== revision.id) });
    const inbox = classifyRunInbox(entry, [withoutTarget], { workflow_name: "study", run_title: null });
    if (!inbox.ok) throw new Error(inbox.error.detail);
    expect(inbox.value.items[0]).toMatchObject({ kind: "gate_decision", artifact_revision_id: null });
  });
});

it("shows a non-merge external review as an ordinary review of its artifact", () => {
  const original = cohort.decisions.find((candidate) => candidate.key === "accept");
  if (!original || original.submit.kind !== "review") throw new Error("captured fixture lacks a cohort review");
  const decision = { ...original, submit: { ...original.submit, review: "closed_review" } };
  const unit = withUnitFields(cohort, { decisions: [decision], reviews: [projectedReview({
    review: "closed_review", of_artifact: "assessment", reviewed_revision_id: original.submit.target_revision_id, wait: "external",
  }, [decision])] });
  const entry: OperatorRunInboxBatchEntry = { run_id: cohort.run_id, items: [
    { kind: "decision", run_id: cohort.run_id, unit_id: cohort.unit_id, key: decision.key,
      label: decision.label, submit: decision.submit, prompt: null },
  ] };
  const inbox = classifyRunInbox(entry, [unit], { workflow_name: "development", run_title: null });
  if (!inbox.ok) throw new Error(inbox.error.detail);
  expect(inbox.value.items[0]).toMatchObject({ kind: "artifact_gate", artifact_revision_id: expect.any(String) });
});
