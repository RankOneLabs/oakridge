import { describe, expect, it } from "vitest";
import sample from "../__fixtures__/v2-adapter-sample.json";
import cohortMerge from "../__fixtures__/v2-cohort-merge.json";
import integrationMerge from "../__fixtures__/v2-integration-merge.json";
import planningRevise from "../__fixtures__/v2-planning-revise.json";
import { retryUnit, sampleCohort as cohort, sampleRun as run, sampleUnits as units, withUnitFields } from "../__fixtures__/read-models";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
import type { OperatorRunEvent } from "../operator-contracts/projections/run-event";
import type { OperatorAttemptView, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { artifactType, artifactTypes, attemptToWorkOrder, compositeId, decisionAction, developmentPullRequestUrl, isVisibleDevelopmentArtifact, latestAttemptPerSession, latestUnitAttemptPerSession, parseCompositeId, repositoryKeyOf, reviewToGates, revisionToArtifact, runEventKind, runSnapshot, unitToStages } from "./core";
import { parseUnitViews } from "./parse";
import { selectRunSessionRows } from "../lib/run-sessions";
import { selectRunSidebarSessions } from "../lib/run-overview";
import { selectCohortArtifactId } from "../lib/cohort-artifact";

describe("v2 development adapters", () => {
  it("keeps the server's update time after a decision with no new publication", () => {
    const updatedAt = "2099-01-01T00:00:00Z";
    const detail = runSnapshot({ ...run, updated_at: updatedAt }, units);
    expect(detail.ok && detail.value.updated_at).toBe(updatedAt);
  });
  it("rejects malformed unit data at the API boundary", () => {
    expect(parseUnitViews([{ ...cohort, decisions: [{ ...cohort.decisions[0], submit: { kind: "review" } }] }]).ok).toBe(false);
  });
  it("groups units into stages with artifacts", () => {
    const stages = unitToStages(units);
    expect(stages.ok && stages.value.find((stage) => stage.name === "cohort")?.artifacts.some((artifact) => artifact.type_id === "dev.build_result")).toBe(true);
  });
  it("shows the prepared workspace as a read-only artifact", () => {
    const prepare = units.find((unit) => unit.stage === "prepare");
    const workspace = (sample.artifacts as unknown as OperatorArtifactDetail[]).find((artifact) => artifact.schema === "workspace");
    if (!prepare || !workspace) throw new Error("captured fixture lacks the prepared workspace");
    const stages = unitToStages(units);
    const detail = revisionToArtifact(workspace, prepare);
    expect(stages.ok && detail.ok && {
      listed: stages.value.find((stage) => stage.name === "prepare")?.artifacts.map((artifact) => artifact.type_id),
      capabilities: detail.value.capabilities,
      body: detail.value.revisions.at(-1)?.body,
    }).toEqual({ listed: ["workspace"], capabilities: { reviewable: false, commentable: false, atom_editable: false, review_items: false },
      body: prepare.artifacts.find((artifact) => artifact.artifact_key === "workspace")?.latest_revision?.body });
  });
  it("offers a retry on a stalled scalar stage's single unit", () => {
    const analysis = withUnitFields(retryUnit("analysis"), { stage: "analysis", collection_key: null });
    const stages = unitToStages([analysis]);
    expect(stages.ok && stages.value[0]?.units?.map((unit) => [unit.unit_id, unit.is_retryable])).toEqual([["0", true]]);
  });
  it("shows the approved text specification as a reviewable artifact", () => {
    const analysis = units.find((unit) => unit.stage === "analysis");
    const oldArtifact = analysis?.artifacts.find((artifact) => artifact.artifact_key === "analysis");
    if (!analysis || !oldArtifact) throw new Error("captured fixture lacks an analysis unit");
    const spec = { ...oldArtifact, artifact_key: "spec", schema: "text",
      latest_revision: oldArtifact.latest_revision ? { ...oldArtifact.latest_revision, body: "Revised requirements" } : null };
    const stage = unitToStages([withUnitFields(analysis, { artifacts: [spec] })]);
    expect(stage.ok && stage.value[0]?.artifacts.map((artifact) => artifact.type_id)).toEqual(["dev.spec"]);
  });
  it("names the two analysis-stage sessions by the document they produce", () => {
    const analysis = units.find((unit) => unit.stage === "analysis");
    const source = cohort.attempts.find((attempt) => attempt.kbbl_session_id);
    if (!analysis || !source) throw new Error("captured fixture lacks an agent attempt");
    const labels = ["author", "spec_editor"].map((worker) => {
      const result = attemptToWorkOrder({ runId: run.run_id, stage: "analysis", unit: analysis,
        attempt: { ...source, worker, unit_id: analysis.unit_id } });
      return result.ok ? [result.value.stage_key, result.value.display_label] : null;
    });
    expect(labels).toEqual([["analysis", "Spec analysis"], ["analysis", "Spec update"]]);
  });
  it("keeps internal PR observations out of the frozen artifact list", () => {
    const pr = cohort.artifacts.find((artifact) => artifact.artifact_key === "pr");
    if (!pr) throw new Error("captured fixture lacks a PR artifact");
    const withObservation = withUnitFields(cohort, { artifacts: [...cohort.artifacts,
      { ...pr, artifact_key: "observed_state", schema: "pr_status" },
      { ...pr, artifact_key: "manual_merge_target" }] });
    const stages = unitToStages([withObservation]);
    expect(stages.ok && [stages.value[0]?.artifacts.some((artifact) => artifact.type_id === "pr_status"),
      stages.value[0]?.artifacts.filter((artifact) => artifact.type_id === "dev.pr_summary").length]).toEqual([false, 1]);
  });
  it("shows builder and assessor as separate cohort sessions, each on its first attempt", () => {
    const sessions = cohort.attempts.filter((attempt) => attempt.kbbl_session_id).map((attempt) =>
      attemptToWorkOrder({ runId: run.run_id, stage: "cohort", unit: cohort, attempt }));
    if (sessions.some((result) => !result.ok)) throw new Error("fixture cohort session mapping failed");
    const rows = selectRunSessionRows(sessions.flatMap((result) => result.ok ? [result.value] : []));
    expect(rows.map((row) => [row.attempt.stage_key, row.attempt.unit_id, row.attempt_number, row.attempt_count])).toEqual([
      ["builder", cohort.collection_key, 1, 1], ["assessment", cohort.collection_key, 1, 1],
    ]);
  });
  it("omits the retired build-change action from pinned assessment reviews", () => {
    const gates = reviewToGates(cohort);
    expect(gates.ok && gates.value.find((gate) => gate.gate_step === "assessment_review")?.resume_actions).toEqual(["approve"]);
  });
  it("gives successive assessment targets distinct review identities while retaining the hidden send offer", () => {
    const first = reviewToGates(cohort);
    const second = reviewToGates({ ...cohort, decisions: cohort.decisions.map((decision) => decision.submit.kind === "review"
      && decision.submit.review === "assessment_review" ? { ...decision,
        submit: { ...decision.submit, target_revision_id: "new-assessment-revision" } } : decision) });
    const oldGate = first.ok ? first.value.find((gate) => gate.gate_step === "assessment_review") : null;
    const newGate = second.ok ? second.value.find((gate) => gate.gate_step === "assessment_review") : null;
    expect({ distinct: oldGate?.id !== newGate?.id, offered: newGate?.offered_decisions?.includes("request_build_changes"),
      displayed: newGate?.resume_actions.includes("request_build_changes") }).toEqual({ distinct: true, offered: true, displayed: false });
  });
  it("keeps assessment revision available on pinned reviews", () => {
    const buildChange = cohort.decisions.find((decision) => decision.key === "request_build_changes");
    if (!buildChange || buildChange.submit.kind !== "review") throw new Error("fixture lacks build change decision");
    const assessmentChange = { ...buildChange, key: "request_assessment_changes", label: "Revise assessment",
      submit: { ...buildChange.submit, decision: "request_assessment_changes",
        target_revision_id: cohort.artifacts.find((artifact) => artifact.artifact_key === "assessment")?.latest_revision?.id ?? "" } };
    const gates = reviewToGates({ ...cohort, decisions: [...cohort.decisions, assessmentChange] });
    expect(gates.ok && gates.value.find((gate) => gate.gate_step === "assessment_review")?.resume_actions)
      .toEqual(["approve", "request_assessment_changes"]);
  });
  it("marks the assessor session as needing the operator when its assessment is published", () => {
    const attempts = cohort.attempts.filter((attempt) => attempt.kbbl_session_id).map((attempt) =>
      attemptToWorkOrder({ runId: run.run_id, stage: "cohort", unit: cohort, attempt }));
    const gates = reviewToGates(cohort);
    if (!gates.ok || attempts.some((attempt) => !attempt.ok)) throw new Error("fixture cohort mapping failed");
    const rows = selectRunSidebarSessions({ sessions: { kind: "loaded", attempts: attempts.flatMap((attempt) => attempt.ok ? [attempt.value] : []) },
      gates: { kind: "loaded", gates: gates.value }, purgedSessionIds: new Set(), archivedSessionIds: new Set() }).rows;
    expect(rows.filter((row) => row.requires_operator_action).map((row) => row.stage_key)).toEqual(["assessment"]);
  });
  it("marks the builder session for a cohort merge confirmation", () => {
    const mergeUnit = (cohortMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.decisions.some((decision) =>
      decision.submit.kind === "review" && decision.submit.review === "merge_confirmation"));
    if (!mergeUnit) throw new Error("captured fixture lacks merge confirmation");
    const builder = mergeUnit.attempts.find((attempt) => attempt.worker === "builder");
    if (!builder) throw new Error("captured fixture lacks a builder session");
    const mapped = attemptToWorkOrder({ runId: mergeUnit.run_id, stage: "cohort", unit: mergeUnit, attempt: builder });
    const gates = reviewToGates(mergeUnit);
    if (!mapped.ok || !gates.ok) throw new Error("fixture merge mapping failed");
    const rows = selectRunSidebarSessions({ sessions: { kind: "loaded", attempts: [mapped.value] },
      gates: { kind: "loaded", gates: gates.value }, purgedSessionIds: new Set(), archivedSessionIds: new Set() }).rows;
    expect(rows[0]?.requires_operator_action).toBe(true);
  });
  it("marks the builder session when a closed pull request needs replacement", () => {
    const mergeUnit = (cohortMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.decisions.some((decision) =>
      decision.submit.kind === "review" && decision.submit.review === "merge_confirmation"));
    if (!mergeUnit) throw new Error("captured fixture lacks merge confirmation");
    const builder = mergeUnit.attempts.find((attempt) => attempt.worker === "builder");
    if (!builder) throw new Error("captured fixture lacks a builder session");
    const closed = withUnitFields(mergeUnit, { decisions: mergeUnit.decisions.map((decision) => decision.submit.kind === "review"
      ? { ...decision, submit: { ...decision.submit, review: "pr_closed" } } : decision) });
    const mapped = attemptToWorkOrder({ runId: closed.run_id, stage: "cohort", unit: closed, attempt: builder });
    const gates = reviewToGates(closed);
    if (!mapped.ok || !gates.ok) throw new Error("fixture closed PR mapping failed");
    const rows = selectRunSidebarSessions({ sessions: { kind: "loaded", attempts: [mapped.value] },
      gates: { kind: "loaded", gates: gates.value }, purgedSessionIds: new Set(), archivedSessionIds: new Set() }).rows;
    expect(rows[0]?.requires_operator_action).toBe(true);
  });
  it("keeps an input-revision review target so the frozen decision button can submit", () => {
    const accept = cohort.decisions.find((decision) => decision.key === "accept");
    if (!accept || accept.submit.kind !== "review") throw new Error("captured fixture lacks an accept review");
    const target = `${cohort.unit_id}:input:1`;
    const inputReview = withUnitFields(cohort, { artifacts: [], decisions: [{ ...accept,
      submit: { ...accept.submit, review: "assessment_review", target_revision_id: target } }] });
    const gates = reviewToGates(inputReview);
    expect(gates.ok && gates.value[0]?.artifact_revision_id).toBe(target);
  });
  it("keeps gate and artifact ids resolvable after a cold load", () => {
    const id = compositeId({ kind: "artifact", runId: run.run_id, unitId: cohort.unit_id, name: "build_result" });
    expect(parseCompositeId(id, "artifact")).toEqual({ ok: true, value: { kind: "artifact", runId: run.run_id, unitId: cohort.unit_id, name: "build_result" } });
  });
  it("maps revisions and dispatches the analysis, spec, and implementation viewers", () => {
    const artifact = revisionToArtifact(sample.artifact as unknown as OperatorArtifactDetail, cohort);
    expect(artifact.ok && artifact.value.component_id).toBe("dev-build-result-viewer");
    expect(artifactTypes().map((type) => type.component_id)).toEqual([
      "dev-spec-analysis-viewer", "dev-spec-viewer", "dev-plan-viewer", "dev-tasks-viewer", "dev-build-brief-viewer",
      "dev-build-result-viewer", "dev-assessment-viewer", "dev-pr-summary-viewer",
    ]);
  });
  it("exposes tasks artifacts with the tasks viewer and type id", () => {
    const artifact = units.flatMap((unit) => unit.artifacts)[0];
    if (!artifact) throw new Error("captured fixture has no artifact");
    expect([isVisibleDevelopmentArtifact({ ...artifact, artifact_key: "tasks", schema: "tasks_body" }), artifactType("tasks_body")])
      .toEqual([true, { id: "dev.tasks", component_id: "dev-tasks-viewer",
        capabilities: { reviewable: true, commentable: true, atom_editable: true, review_items: true }, anchor_schema: null }]);
  });
  it("retains the cohort label so assessment revisions can find their brief", () => {
    const artifact = revisionToArtifact(sample.artifact as unknown as OperatorArtifactDetail, cohort);
    const runDetail = runSnapshot(run, units);
    expect(artifact.ok && runDetail.ok && artifact.value.label
      ? selectCohortArtifactId(runDetail.value, "dev.build_brief", artifact.value.label)
      : null).not.toBeNull();
  });
  it("maps a v2 attempt to the v1 work order reason and state", () => {
    const builder = cohort.attempts.find((attempt) => attempt.worker === "builder");
    if (!builder) throw new Error("captured fixture lacks a builder attempt");
    const attempt = attemptToWorkOrder({ runId: run.run_id, stage: "cohort", unit: cohort, attempt: builder });
    expect(attempt.ok && [attempt.value.reason, attempt.value.work_order_state, attempt.value.completed_at]).toEqual(["initial", "completed", null]);
  });
  it("labels the shared brief writer without naming one cohort", () => {
    const brief = units.find((unit) => unit.stage === "brief" && unit.attempts.some((attempt) => attempt.worker === "writer"));
    if (!brief) throw new Error("captured fixture lacks a brief writer attempt");
    const writer = brief.attempts.find((attempt) => attempt.worker === "writer");
    if (!writer) throw new Error("captured fixture lacks a brief writer attempt");
    const mapped = attemptToWorkOrder({ runId: run.run_id, stage: "brief", unit: brief, attempt: writer });
    expect(mapped.ok && mapped.value.unit_id).toBe("shared writer");
  });
  it("represents a planning revision in its reused kbbl session once", () => {
    const selected = latestAttemptPerSession(planningRevise.attempts as OperatorAttemptView[]);
    expect(selected.ok && selected.value.map((attempt) => [attempt.kbbl_session_id, attempt.mode, attempt.cause.kind]))
      .toEqual([[planningRevise.attempts[0]?.kbbl_session_id, "revise", "changes_requested"]]);
  });
  it("shows one session when separate brief units share its physical sid", () => {
    const first = units.find((unit) => unit.stage === "brief" && unit.attempts.length > 0);
    if (!first) throw new Error("captured fixture lacks a brief attempt");
    const second = withUnitFields(first, { unit_id: `${first.unit_id}-other`, attempts: first.attempts.map((attempt) => ({
      ...attempt, id: `${attempt.id}-other`, unit_id: `${first.unit_id}-other`, created_at: "9999-01-01T00:00:00Z" })) });
    const selected = latestUnitAttemptPerSession([first, second]);
    expect(selected.ok && selected.value.map(({ unit }) => unit.unit_id)).toEqual([second.unit_id]);
  });
  it("maps a run event kind", () => {
    const event = runEventKind(sample.event as OperatorRunEvent);
    expect(event.ok && event.value?.operation).toBe("slot_released");
  });
  it("does not report a worker ending as unit completion", () => {
    const event = runEventKind({ ...sample.event, kind: "worker_ended" } as OperatorRunEvent);
    expect(event).toEqual({ ok: true, value: null });
  });
  it("maps an approve-effect decision onto a v1 action the frozen gate UI renders", () => {
    const accept = cohort.decisions.find((decision) => decision.key === "accept");
    const merge = (cohortMerge.units as unknown as OperatorUnitView[])
      .flatMap((unit) => unit.decisions).find((decision) => decision.key === "confirm_merged");
    if (!accept || !merge) throw new Error("captured fixtures lack the approve decisions");
    expect([decisionAction(accept), decisionAction(merge)]).toEqual(["approve", "confirm_merged"]);
  });
  it("parses repository keys from untrusted unit input", () => {
    const padded = withUnitFields(cohort, { input: { repository_key: "  app  " } });
    const blank = withUnitFields(cohort, { input: { repository_key: "  " } });
    expect([repositoryKeyOf(padded), repositoryKeyOf(blank)]).toEqual(["app", null]);
  });
  it("does not expose an unsafe PR artifact URL as a clickable merge link", () => {
    const mergeUnit = (cohortMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.decisions.some((decision) =>
      decision.submit.kind === "review" && decision.submit.review === "merge_confirmation"));
    if (!mergeUnit) throw new Error("captured fixture lacks merge confirmation");
    const unsafe = withUnitFields(mergeUnit, { artifacts: mergeUnit.artifacts.map((artifact) =>
      artifact.artifact_key === "pr" && artifact.latest_revision
        ? { ...artifact, latest_revision: { ...artifact.latest_revision, body: { pr_url: "javascript:alert(1)" } } }
        : artifact) });
    expect(developmentPullRequestUrl(unsafe)).toBeNull();
  });
  it.each([cohortMerge, integrationMerge])("captures confirm_merged on the unit's current revision", (fixture) => {
    const unit = fixture.units.find((candidate) => candidate.decisions.some((decision) => decision.key === "confirm_merged"));
    if (!unit) throw new Error("captured merge fixture lacks confirm_merged");
    const gates = reviewToGates(unit as unknown as OperatorUnitView);
    expect(gates.ok && gates.value.find((gate) => gate.gate_step === "merge_confirmation")?.resume_actions).toEqual(["confirm_merged"]);
  });
});
