import { expect, test } from "bun:test";

import type { ArtifactId, StageInstanceId, UnitId, WaitId } from "../src/domain/primitives";
import {
  selectGateStateView, selectHandoffStateView, selectHandoffStatusFromWait,
  type Wait, type WaitClosesOn, type WaitOutcome,
} from "../src/domain/wait";

const wait = (closes_on: WaitClosesOn, status: Wait["status"], overrides: Partial<Wait> = {}): Wait => ({
  id: "00000000-0000-4000-8000-0000000000f1" as WaitId,
  stage_instance_id: "stage-1" as StageInstanceId,
  unit_id: "unit-1" as UnitId,
  artifact_revision_id: "artifact-1" as ArtifactId,
  closes_on, status,
  run_unit_id: null,
  output_name: null,
  execution_workflow_id: "execution-workflow-1",
  command_workflow_id: "execution-workflow-1:gate:artifact-1:wait:artifact_approval",
  opened_at: "2026-08-21T12:00:00.000Z",
  ...overrides,
});

const closed = (outcome: WaitOutcome): Wait["status"] => ({ kind: "closed", outcome, closed_at: "2026-08-21T12:30:00.000Z" });
const gateClosesOn: WaitClosesOn = { kind: "gate", gate_step: "artifact_approval", actions: ["approve", "request_revision"] };
const downstreamClosesOn: WaitClosesOn = { kind: "handoff_downstream", downstream_role: "assessment" };
const externalClosesOn: WaitClosesOn = { kind: "handoff_external", external_wait_kind: "github_review", decision_artifact_id: "decision-1" as ArtifactId };

test("a missing gate wait views as null", () => {
  expect(selectGateStateView(null)).toBeNull();
});

test("an open gate wait views as pending with the row's coordinates", () => {
  expect(selectGateStateView(wait(gateClosesOn, { kind: "open" }))).toEqual({
    status: "pending", artifact_revision_id: "artifact-1" as ArtifactId, gate_step: "artifact_approval",
    command_workflow_id: "execution-workflow-1:gate:artifact-1:wait:artifact_approval",
  });
});

test("a decided gate wait views as closed with its action", () => {
  const view = selectGateStateView(wait(gateClosesOn, closed({ kind: "decided", action: "approve", decision_artifact_id: null, feedback: null })));
  expect(view).toEqual(expect.objectContaining({ status: "closed", action: "approve" }));
});

test("a superseded gate wait views as superseded", () => {
  expect(selectGateStateView(wait(gateClosesOn, closed({ kind: "superseded", replacement_artifact_revision_id: "artifact-2" as ArtifactId })))?.status).toBe("superseded");
});

test("a withdrawn gate wait views as withdrawn", () => {
  expect(selectGateStateView(wait(gateClosesOn, closed({ kind: "withdrawn" })))?.status).toBe("withdrawn");
});

test("cancelled gate and handoff waits remain readable terminal states", () => {
  expect(selectGateStateView(wait(gateClosesOn, closed({ kind: "cancelled", reason: "run cancelled" })))?.status).toBe("cancelled");
  expect(selectHandoffStatusFromWait("handoff_external", "closed", "cancelled")).toBe("cancelled");
});

test("an open external wait maps to awaiting_external", () => {
  expect(selectHandoffStatusFromWait("handoff_external", "open", null)).toBe("awaiting_external");
});

test("a completed external wait maps to released", () => {
  expect(selectHandoffStatusFromWait("handoff_external", "closed", "external_completed")).toBe("released");
});

test("an open downstream wait maps to awaiting_downstream", () => {
  expect(selectHandoffStatusFromWait("handoff_downstream", "open", null)).toBe("awaiting_downstream");
});

test("a decided downstream wait maps to revision_requested", () => {
  expect(selectHandoffStatusFromWait("handoff_downstream", "closed", "decided")).toBe("revision_requested");
});

test("a superseded wait of either kind maps to superseded", () => {
  expect(selectHandoffStatusFromWait("handoff_downstream", "closed", "superseded")).toBe("superseded");
  expect(selectHandoffStatusFromWait("handoff_external", "closed", "superseded")).toBe("superseded");
});

test("a withdrawn wait of either kind maps to withdrawn", () => {
  expect(selectHandoffStatusFromWait("handoff_downstream", "closed", "withdrawn")).toBe("withdrawn");
  expect(selectHandoffStatusFromWait("handoff_external", "closed", "withdrawn")).toBe("withdrawn");
});

test("no handoff rows view as null", () => {
  expect(selectHandoffStateView([])).toBeNull();
});

test("the external row is preferred over the downstream row when both exist", () => {
  const view = selectHandoffStateView([
    wait(downstreamClosesOn, closed({ kind: "decided", action: "approve", decision_artifact_id: "decision-1" as ArtifactId, feedback: null })),
    wait(externalClosesOn, { kind: "open" }),
  ]);
  expect(view?.status).toBe("awaiting_external");
});

test("downstream_role fills in every status, from the downstream row's closes_on", () => {
  const view = selectHandoffStateView([
    wait(downstreamClosesOn, closed({ kind: "decided", action: "approve", decision_artifact_id: "decision-1" as ArtifactId, feedback: null })),
    wait(externalClosesOn, closed({ kind: "external_completed", correlation_id: "pr-42" })),
  ]);
  expect(view).toEqual(expect.objectContaining({ status: "released", downstream_role: "assessment" }));
});

test("a superseded external row reports its decision_artifact_id from closes_on", () => {
  const view = selectHandoffStateView([
    wait(externalClosesOn, closed({ kind: "superseded", replacement_artifact_revision_id: "artifact-2" as ArtifactId })),
  ]);
  expect(view).toEqual(expect.objectContaining({ status: "superseded", decision_artifact_id: "decision-1" }));
});

test("the revision path reports the decision from the downstream decided outcome", () => {
  const view = selectHandoffStateView([
    wait(downstreamClosesOn, closed({ kind: "decided", action: "request_revision", decision_artifact_id: "decision-1" as ArtifactId, feedback: "revise" })),
  ]);
  expect(view).toEqual(expect.objectContaining({ status: "revision_requested", decision_artifact_id: "decision-1" }));
});
