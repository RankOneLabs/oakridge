import { describe, expect, it } from "vitest";
import sample from "../__fixtures__/v2-adapter-sample.json";
import cohortMerge from "../__fixtures__/v2-cohort-merge.json";
import integrationMerge from "../__fixtures__/v2-integration-merge.json";
import planningRevise from "../__fixtures__/v2-planning-revise.json";
import { withUnitFields } from "../__fixtures__/read-models";
import type { OperatorArtifactDetail, OperatorAttemptView, OperatorRunEvent, OperatorRunInboxBatchEntry, OperatorRunView, OperatorUnitView } from "../operator-contracts";
import { artifactTypes, attemptToWorkOrder, compositeId, decisionAction, deriveStatus, developmentPullRequestUrl, latestAttemptPerSession, latestUnitAttemptPerSession, parseCompositeId, reviewToGates, revisionToArtifact, runEventKind, runSnapshot, runSummary, statusInputOf, unitToStages } from "./core";
import { classifyDevelopmentInbox, replaceDevelopmentInboxRun } from "./inbox";
import { parseUnitViews } from "./parse";
import { selectRunSessionRows } from "../lib/run-sessions";
import { selectRunSidebarSessions } from "../lib/run-overview";
import { selectCohortArtifactId } from "../lib/cohort-artifact";

const run = sample.run as unknown as OperatorRunView;
const units = sample.units as unknown as OperatorUnitView[];
const cohort = units.find((unit) => unit.stage === "cohort" && unit.decisions.some((decision) => decision.submit.kind === "review"));
if (!cohort) throw new Error("captured fixture lacks a cohort review");

describe("v2 development adapters", () => {
  it("maps a run snapshot and summary through the same status derivation", () => {
    const detail = runSnapshot(run, units);
    expect(detail.ok && [detail.value.status, runSummary(detail.value, run).status]).toEqual(["parked", "parked"]);
  });
  it("keeps the server's update time after a decision with no new publication", () => {
    const updatedAt = "2099-01-01T00:00:00Z";
    const detail = runSnapshot({ ...run, updated_at: updatedAt }, units);
    expect(detail.ok && detail.value.updated_at).toBe(updatedAt);
  });
  it("shows a cancelled run even when a child unit still carries an old failure", () => {
    const detail = runSnapshot({ ...run, status: { kind: "cancelled" } }, units);
    expect(detail.ok && detail.value.status).toBe("cancelled");
  });
  it("keeps an active run stuck while a brief unit has failed", () => {
    const failedBrief = withUnitFields(cohort, { stage: "brief", attention: { kind: "stalled", detail: "writer failed" } });
    const detail = runSnapshot({ ...run, status: { kind: "active" } }, [failedBrief]);
    expect(detail.ok && [detail.value.status, detail.value.is_stuck,
      runSummary(detail.value, run).is_failed]).toEqual(["running", true, false]);
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
  it("exposes a pending admission control in the frozen stage row while the run remains parked", () => {
    const original = cohort.decisions.find((decision) => decision.submit.kind === "review");
    const briefRevision = cohort.artifacts.find((artifact) => artifact.artifact_key === "brief")?.latest_revision;
    if (!original || original.submit.kind !== "review" || !briefRevision) throw new Error("fixture lacks cohort review and brief");
    const awaiting = withUnitFields(cohort, { attention: { kind: "waiting", reason: "awaiting admission review" },
      decisions: [{ ...original, key: "admit", submit: { ...original.submit, review: "admission", decision: "admit",
        effect: "approve", target_revision_id: briefRevision.id } }] });
    const stages = unitToStages([awaiting]);
    const unit = stages.ok ? stages.value[0]?.units?.[0] : null;
    expect([stages.ok && stages.value[0]?.status, unit?.status, unit?.admission_required,
      unit?.admitted, unit?.admission_eligible]).toEqual(["parked", "pending", true, false, true]);
  });
  it("maps reviews to gates and change effects to the feedback action", () => {
    const gates = reviewToGates(cohort);
    expect(gates.ok && gates.value.find((gate) => gate.gate_step === "assessment_review")?.resume_actions).toEqual(["approve", "request_build_changes"]);
    expect(decisionAction(cohort.decisions.find((decision) => decision.key === "request_build_changes")!)).toBe("request_build_changes");
  });
  it("keeps assessment and build revision choices distinct", () => {
    const buildChange = cohort.decisions.find((decision) => decision.key === "request_build_changes");
    if (!buildChange || buildChange.submit.kind !== "review") throw new Error("fixture lacks build change decision");
    const assessmentChange = { ...buildChange, key: "request_assessment_changes", label: "Revise assessment",
      submit: { ...buildChange.submit, decision: "request_assessment_changes",
        target_revision_id: cohort.artifacts.find((artifact) => artifact.artifact_key === "assessment")?.latest_revision?.id ?? "" } };
    const gates = reviewToGates({ ...cohort, decisions: [...cohort.decisions, assessmentChange] });
    expect(gates.ok && gates.value.find((gate) => gate.gate_step === "assessment_review")?.resume_actions)
      .toEqual(["approve", "request_build_changes", "request_assessment_changes"]);
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
      submit: { ...accept.submit, review: "admission", target_revision_id: target } }] });
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
      "dev-spec-analysis-viewer", "dev-spec-viewer", "dev-plan-viewer", "dev-build-brief-viewer",
      "dev-build-result-viewer", "dev-assessment-viewer", "dev-pr-summary-viewer",
    ]);
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
  it("distinguishes a stalled worker from a parked review", () => {
    expect(deriveStatus({ status: cohort.status, attention: { kind: "stalled", detail: "worker failed" }, attempts: cohort.attempts, decisions: cohort.decisions }).run).toBe("failed");
  });
  it.each(["invalid_instruction", "discovery_unsupported"])("parks a cohort with manual merge confirmation despite a %s PR watcher failure", (code) => {
    const mergeRun = cohortMerge.run as unknown as OperatorRunView;
    const mergeUnits = cohortMerge.units as unknown as OperatorUnitView[];
    const mergeUnit = mergeUnits.find((unit) => unit.decisions.some((decision) => decision.submit.kind === "review"
      && decision.submit.decision === "confirm_merged"));
    if (!mergeUnit) throw new Error("captured fixture lacks merge confirmation");
    const observedState = mergeUnit.artifacts.find((artifact) => artifact.artifact_key === "pr_state");
    if (!observedState) throw new Error("captured fixture lacks a PR state artifact");
    const stalled = withUnitFields(mergeUnit, {
      artifacts: [...mergeUnit.artifacts, { ...observedState, artifact_key: "observed_state" }],
      attention: { kind: "stalled", detail: "pr_watch failed: no pull request reader is configured" },
      attempts: mergeUnit.attempts.map((attempt) => attempt.worker === "pr_watch"
        ? { ...attempt, status: "failed", failure: { code, detail: "no pull request reader is configured" } }
        : attempt) });
    const detail = runSnapshot(mergeRun, mergeUnits.map((unit) => unit.unit_id === mergeUnit.unit_id ? stalled : unit));
    expect(detail.ok && [detail.value.stages.find((stage) => stage.name === "cohort")?.status,
      detail.value.status, runSummary(detail.value, mergeRun).status]).toEqual(["parked", "parked", "parked"]);
  });
  it("keeps a cohort on the old pinned definition failed when its watcher blocks completion", () => {
    const mergeUnit = (cohortMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.decisions.some((decision) => decision.submit.kind === "review"
      && decision.submit.decision === "confirm_merged"));
    if (!mergeUnit) throw new Error("captured fixture lacks merge confirmation");
    expect(deriveStatus({ ...statusInputOf(mergeUnit), attention: { kind: "stalled", detail: "pr_watch failed: missing URL" },
      attempts: mergeUnit.attempts.map((attempt) => attempt.worker === "pr_watch"
        ? { ...attempt, status: "failed", failure: { code: "invalid_instruction", detail: "missing URL" } }
        : attempt) }).run).toBe("failed");
  });
  it("keeps a PR mismatch visible as a failed cohort even with merge confirmation", () => {
    const mergeUnit = (cohortMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.decisions.some((decision) => decision.submit.kind === "review"
      && decision.submit.decision === "confirm_merged"));
    if (!mergeUnit) throw new Error("captured fixture lacks merge confirmation");
    expect(deriveStatus({ ...statusInputOf(mergeUnit), attention: { kind: "stalled", detail: "pr_watch failed: PR branch differs" },
      attempts: mergeUnit.attempts.map((attempt) => attempt.worker === "pr_watch"
        ? { ...attempt, status: "failed", failure: { code: "pull_request_mismatch", detail: "PR branch differs" } }
        : attempt) }).run).toBe("failed");
  });
  it("parks a unit awaiting the operator and leaves a dependency wait pending", () => {
    const blocked = units.find((unit) => unit.attention?.kind === "waiting" && unit.decisions.length === 0);
    if (!blocked) throw new Error("captured fixture lacks a dependency wait");
    expect([deriveStatus(statusInputOf(cohort)).run, deriveStatus(statusInputOf(blocked)).run]).toEqual(["parked", "pending"]);
  });
  it("shows a reviewable revision as parked after its worker failed, in both list and detail", () => {
    const failed = { ...cohort, attention: { kind: "waiting" as const, reason: "awaiting assessment_review review" },
      attempts: [{ ...cohort.attempts[0]!, status: "failed" as const,
        failure: { code: "no_output", detail: "worker ended before publishing" }, is_current: true }] };
    const detail = runSnapshot(run, units.map((unit) => unit.unit_id === cohort.unit_id ? failed : unit));
    expect(detail.ok && [detail.value.stages.find((stage) => stage.name === cohort.stage)?.status,
      detail.value.status, runSummary(detail.value, run).status]).toEqual(["parked", "parked", "parked"]);
  });
  it("maps an approve-effect decision onto a v1 action the frozen gate UI renders", () => {
    const accept = cohort.decisions.find((decision) => decision.key === "accept");
    const merge = (cohortMerge.units as unknown as OperatorUnitView[])
      .flatMap((unit) => unit.decisions).find((decision) => decision.key === "confirm_merged");
    if (!accept || !merge) throw new Error("captured fixtures lack the approve decisions");
    expect([decisionAction(accept), decisionAction(merge)]).toEqual(["approve", "confirm_merged"]);
  });
  it("classifies a development workflow inbox with a cohort lifecycle", () => {
    const inbox = classifyDevelopmentInbox(sample.inbox as unknown as { run_id: string; items: readonly import("../operator-contracts").OperatorInboxItem[] }, units);
    expect(inbox.ok && [inbox.value.items[0].kind, inbox.value.cohorts[0].lifecycle]).toEqual(["artifact_gate", "artifact_review"]);
    expect(inbox.ok && inbox.value.items.filter((item) => item.kind === "artifact_gate")).toHaveLength(1);
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
    const inbox = classifyDevelopmentInbox(entry, briefUnits);
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
    const inbox = classifyDevelopmentInbox(entry, [stalled]);
    expect(inbox.ok && [inbox.value.items.map((item) => item.kind), inbox.value.cohorts[0]?.lifecycle])
      .toEqual([["merge_confirmation"], "merge_confirmation"]);
    expect(inbox.ok && inbox.value.items[0]?.pr_url).toBe("https://github.com/oakridge-e2e/app/pull/1");
    const gates = reviewToGates(stalled);
    expect(gates.ok && gates.value[0]?.pr_url).toBe("https://github.com/oakridge-e2e/app/pull/1");
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
  it("keeps both run slices when invalidate responses complete against an old inbox snapshot", () => {
    const first = classifyDevelopmentInbox(sample.inbox as unknown as { run_id: string; items: readonly import("../operator-contracts").OperatorInboxItem[] }, units);
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
  it.each([cohortMerge, integrationMerge])("captures confirm_merged on the unit's current revision", (fixture) => {
    const unit = fixture.units.find((candidate) => candidate.decisions.some((decision) => decision.key === "confirm_merged"));
    if (!unit) throw new Error("captured merge fixture lacks confirm_merged");
    const gates = reviewToGates(unit as unknown as OperatorUnitView);
    expect(gates.ok && gates.value.find((gate) => gate.gate_step === "merge_confirmation")?.resume_actions).toEqual(["confirm_merged"]);
  });
});
