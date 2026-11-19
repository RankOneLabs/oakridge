import { describe, expect, it } from "vitest";
import sample from "../__fixtures__/v2-adapter-sample.json";
import cohortMerge from "../__fixtures__/v2-cohort-merge.json";
import integrationMerge from "../__fixtures__/v2-integration-merge.json";
import { sampleCohort as cohort, sampleRun as run, sampleUnits as units, withUnitFields } from "../__fixtures__/read-models";
import type { OperatorRunInboxBatchEntry } from "../operator-contracts/projections/inbox";
import type { OperatorDecisionDefinition, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { objectValue, repositoryKeyOf, reviewToGates } from "./core";
import { classifyDevelopmentInbox, replaceDevelopmentInboxRun } from "./inbox";
import { selectOpenBlockerGate } from "./gates";
import parkedBlocker from "../__fixtures__/parked-blocker-unit.json";

describe("development inbox", () => {
  it("classifies a development workflow inbox with a cohort lifecycle", () => {
    const inbox = classifyDevelopmentInbox(sample.inbox as unknown as { run_id: string; items: readonly import("../operator-contracts/projections/inbox").OperatorInboxItem[] }, units, { workflow_name: "development", run_title: null });
    expect(inbox.ok && [inbox.value.items[0].kind, inbox.value.cohorts[0].lifecycle]).toEqual(["artifact_gate", "artifact_review"]);
    expect(inbox.ok && inbox.value.items.filter((item) => item.kind === "artifact_gate")).toHaveLength(1);
    expect(inbox.ok && inbox.value.items[0].resume_actions).toEqual(["approve"]);
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
    const result = classifyDevelopmentInbox(entry, runUnits, { workflow_name: "development", run_title: "Ship Oakridge" });
    if (!result.ok) throw new Error(result.error.detail);
    const firstItem = result.value.items.find((item) => item.unit_id === "a");
    const secondItem = result.value.items.find((item) => item.unit_id === "b");
    const analysisItem = result.value.items.find((item) => item.stage_name === "analysis");
    const planningItem = result.value.items.find((item) => item.stage_name === "planning");
    const briefItem = result.value.items.find((item) => item.stage_name === "brief" && item.unit_id === "a");
    expect([firstItem?.title, secondItem?.title, secondItem?.blocked_by.includes("a · Cohort a · app"), analysisItem?.title])
      .toEqual(["a · Cohort a · app", "b · Cohort b · docs", true, ""]);
    expect(result.value.cohorts.map((item) => [item.title, item.repository_key]))
      .toEqual([["a · Cohort a · app", "app"], ["b · Cohort b · docs", "docs"]]);
    expect(briefItem?.title).toBe("a · Cohort a · app");
    expect([repositoryKeyOf(analysis), repositoryKeyOf(planningWithKey), repositoryKeyOf(brief), repositoryKeyOf(cohort),
      repositoryKeyOf(prepare), repositoryKeyOf(integration), analysisItem?.repository_key, planningItem?.repository_key])
      .toEqual([null, "app", "app", "app", "app", "app", null, "app"]);
  });
  it("keeps inbox work and other cohort summaries when one repository input is missing", () => {
    const withoutRepository = withUnitFields(cohort, { input: {} });
    const other = units.find((unit) => unit.stage === "cohort" && unit.unit_id !== cohort.unit_id);
    if (!other) throw new Error("captured fixture lacks another cohort");
    const result = classifyDevelopmentInbox({ run_id: run.run_id, items: [
      { kind: "waiting", run_id: run.run_id, unit_id: cohort.unit_id, reason: "awaiting prerequisite", label: "Awaiting prerequisite" },
    ] }, [withoutRepository, other], { workflow_name: "development", run_title: null });
    expect(result.ok && [result.value.cohorts.map((summary) => summary.unit_id), result.value.items[0]?.repository_key])
      .toEqual([[other.collection_key], null]);
  });
  it("lists a parked blocker once, as a blocker item that opens its unit", () => {
    const blocked = parkedBlocker as unknown as OperatorUnitView;
    const result = classifyDevelopmentInbox({ run_id: blocked.run_id, items: [
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
  it("uses an analysis blocker's unit id when it has no attention label", () => {
    const analysis = units.find((unit) => unit.stage === "analysis");
    if (!analysis) throw new Error("captured fixture lacks an analysis unit");
    const blocked = withUnitFields(cohort, { depends_on: [analysis.unit_id] });
    const result = classifyDevelopmentInbox({ run_id: run.run_id, items: [
      { kind: "waiting", run_id: run.run_id, unit_id: blocked.unit_id, reason: "awaiting prerequisite", label: "Awaiting prerequisite" },
    ] }, [blocked, analysis], { workflow_name: "development", run_title: null });
    expect(result.ok && result.value.items[0]?.blocked_by).toEqual([analysis.unit_id]);
  });
  it("shows one recovery item per failed brief when each has a retry and a stalled diagnostic", () => {
    const briefUnits = ["first", "second"].map((name) => withUnitFields(cohort, {
      unit_id: `${run.run_id}/briefs/${name}`, unit_key: name, collection_key: name,
      label: `Brief ${name}`, stage: "brief", decisions: [], artifacts: [],
    }));
    const entry: OperatorRunInboxBatchEntry = { run_id: run.run_id, items: briefUnits.flatMap((unit) => [
      { kind: "decision" as const, run_id: run.run_id, unit_id: unit.unit_id, key: "retry:writer",
        label: "Retry Writer", submit: { kind: "retry" as const, worker: "writer" }, prompt: null },
      { kind: "stalled" as const, run_id: run.run_id, unit_id: unit.unit_id, detail: "writer failed" },
    ]) };
    const inbox = classifyDevelopmentInbox(entry, briefUnits, { workflow_name: "development", run_title: null });
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
      attention: { kind: "stalled", detail: "pr_watch failed: no pull request reader is configured" },
      attempts: mergeUnit.attempts.map((attempt) => attempt.worker === "pr_watch"
        ? { ...attempt, status: "failed", failure: { code: "discovery_unsupported", detail: "no pull request reader is configured" } }
        : attempt) });
    const entry: OperatorRunInboxBatchEntry = { run_id: stalled.run_id, items: [
      { kind: "decision", run_id: stalled.run_id, unit_id: stalled.unit_id, key: confirm.key,
        label: confirm.label, submit: confirm.submit, prompt: null },
      { kind: "decision", run_id: stalled.run_id, unit_id: stalled.unit_id, key: "retry:pr_watch",
        label: "Retry PR watch", submit: { kind: "retry", worker: "pr_watch" }, prompt: null },
      { kind: "stalled", run_id: stalled.run_id, unit_id: stalled.unit_id,
        detail: "pr_watch failed: no pull request reader is configured" },
    ] };
    const inbox = classifyDevelopmentInbox(entry, [stalled], { workflow_name: "development", run_title: null });
    expect(inbox.ok && [inbox.value.items.map((item) => item.kind), inbox.value.cohorts[0]?.lifecycle])
      .toEqual([["merge_confirmation"], "merge_confirmation"]);
    expect(inbox.ok && inbox.value.items[0]?.pr_url).toBe("https://github.com/oakridge-e2e/app/pull/1");
    const gates = reviewToGates(stalled);
    expect(gates.ok && gates.value[0]?.pr_url).toBe("https://github.com/oakridge-e2e/app/pull/1");
  });
  it("keeps both run slices when invalidate responses complete against an old inbox snapshot", () => {
    const first = classifyDevelopmentInbox(sample.inbox as unknown as { run_id: string; items: readonly import("../operator-contracts/projections/inbox").OperatorInboxItem[] }, units, { workflow_name: "development", run_title: null });
    if (!first.ok) throw new Error(first.error.detail);
    const secondRun = "run-another";
    const second = { cohorts: first.value.cohorts.map((cohort) => ({ ...cohort, run_id: secondRun })),
      items: first.value.items.map((item) => ({ ...item, run_id: secondRun })) };
    const latest = replaceDevelopmentInboxRun(first.value, secondRun, second);
    const changedFirst = { cohorts: first.value.cohorts, items: [] };
    const combined = replaceDevelopmentInboxRun(latest, run.run_id, changedFirst);
    expect([combined.items.some((item) => item.run_id === run.run_id), combined.items.some((item) => item.run_id === secondRun)])
      .toEqual([false, true]);
  });
  it("labels integration review work with the assessment it asks the operator to judge", () => {
    const integration = (integrationMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.stage === "integration");
    if (!integration) throw new Error("captured fixture lacks an integration unit");
    const items = integration.decisions.flatMap((decision) => decision.submit.kind === "review" ? [{ kind: "decision" as const,
      run_id: integration.run_id, unit_id: integration.unit_id, key: decision.key, label: decision.label, submit: decision.submit, prompt: null }] : []);
    const result = classifyDevelopmentInbox({ run_id: integration.run_id, items }, [integration], { workflow_name: "development", run_title: null });
    expect(result.ok && result.value.items.map((item) => [item.kind, item.artifact_key]))
      .toEqual([["artifact_gate", "assessment"], ["merge_confirmation", "pr_state"]]);
  });
});

describe("study inbox", () => {
  const revision = cohort.artifacts.find((artifact) => artifact.artifact_key === "assessment")?.latest_revision;
  if (!revision) throw new Error("captured fixture lacks an artifact revision");

  const approve: OperatorDecisionDefinition = {
    key: "approve", label: "Approve", fields: [], payload_schema: "{}",
    submit: { kind: "review", review: "report_review", decision: "approve", effect: "approve", target_revision_id: revision.id },
  };
  const requestChanges: OperatorDecisionDefinition = {
    key: "request_changes", label: "Request changes", fields: [{ key: "feedback", label: "What needs to change?" }],
    payload_schema: "{feedback: text}",
    submit: { kind: "review", review: "report_review", decision: "request_changes", effect: "request_changes", target_revision_id: revision.id },
  };
  const unit = withUnitFields(cohort, {
    stage: "synthesis", collection_key: null, unit_key: "synthesis",
    decisions: [approve, requestChanges], input: { repository_key: "oakridge" },
  });
  const entry: OperatorRunInboxBatchEntry = { run_id: unit.run_id, items: [
    { kind: "decision", run_id: unit.run_id, unit_id: unit.unit_id, key: approve.key,
      label: approve.label, submit: approve.submit, prompt: null },
  ] };

  it("carries the study workflow name and title to every item", () => {
    const inbox = classifyDevelopmentInbox(entry, [unit], { workflow_name: "study", run_title: "Study run" });
    if (!inbox.ok) throw new Error(inbox.error.detail);
    expect(inbox.value.items.map(({ workflow_name, run_title }) => [workflow_name, run_title])).toEqual([["study", "Study run"]]);
  });

  it("offers both decisions for a review targeting the unit's latest artifact revision", () => {
    const inbox = classifyDevelopmentInbox(entry, [unit], { workflow_name: "study", run_title: null });
    if (!inbox.ok) throw new Error(inbox.error.detail);
    expect(inbox.value.items).toHaveLength(1);
    expect(inbox.value.items[0]).toMatchObject({
      kind: "artifact_gate", workflow_name: "study",
      gate_id: expect.any(String), artifact_revision_id: expect.any(String),
      resume_actions: ["approve", "request_revision"],
    });
  });

  it("keeps a review with no matching artifact revision as a gate decision", () => {
    const withoutTarget = withUnitFields(unit, { artifacts: unit.artifacts.filter((artifact) => artifact.latest_revision?.id !== revision.id) });
    const inbox = classifyDevelopmentInbox(entry, [withoutTarget], { workflow_name: "study", run_title: null });
    if (!inbox.ok) throw new Error(inbox.error.detail);
    expect(inbox.value.items[0]).toMatchObject({ kind: "gate_decision", artifact_revision_id: null });
  });
});

it("keeps a development cohort's PR-closed review as a gate decision even with artifact evidence", () => {
  const decision = cohort.decisions.find((candidate) => candidate.key === "accept");
  if (!decision || decision.submit.kind !== "review") throw new Error("captured fixture lacks a cohort review");
  const entry: OperatorRunInboxBatchEntry = { run_id: cohort.run_id, items: [
    { kind: "decision", run_id: cohort.run_id, unit_id: cohort.unit_id, key: decision.key,
      label: decision.label, submit: { ...decision.submit, review: "pr_closed" }, prompt: null },
  ] };
  const inbox = classifyDevelopmentInbox(entry, [cohort], { workflow_name: "development", run_title: null });
  if (!inbox.ok) throw new Error(inbox.error.detail);
  expect(inbox.value.items[0]).toMatchObject({ kind: "gate_decision", artifact_revision_id: expect.any(String) });
});
