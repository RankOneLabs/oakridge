import { expect, it } from "vitest";
import { installStatus } from "../__fixtures__/install-status";
import { selectStatusCondition, selectStatusSections, type StatusCondition } from "./status-condition";
import { selectConditionTone } from "./status-tone";
import type { OperatorInstallCheck } from "../operator-contracts/projections/install-status-view";
const healthy: OperatorInstallCheck = { kind: "ok", id: "test", label: "Test", detail: "ready", required: false };
const failed: OperatorInstallCheck = { ...healthy, kind: "failed", fix: "Repair it" };
it.each([false, true])("carries the fix for required=%s failures", (required) => {
  expect(selectStatusCondition({ kind: "check", check: { ...failed, required } })).toEqual({ kind: "failed", fix: "Repair it" });
});
it("maps a healthy check", () => expect(selectStatusCondition({ kind: "check", check: healthy })).toEqual({ kind: "healthy" }));
it("carries unavailable fixes", () => expect(selectStatusCondition({ kind: "observation", check: installStatus.observation.availability })).toEqual({ kind: "unavailable", fix: "Start with --observation" }));
it.each([healthy, failed])("disabled profiles override readiness $kind", (readiness) => {
  expect(selectStatusCondition({ kind: "agent_profile", profile: { profile_id: "agent", label: "Agent", enabled: false, readiness } })).toEqual({ kind: "disabled", reason: "profile_disabled" });
});
it("enabled profiles expose failures", () => expect(selectStatusCondition({ kind: "agent_profile", profile: { profile_id: "agent", label: "Agent", enabled: true, readiness: failed } })).toEqual({ kind: "failed", fix: "Repair it" }));
it("none disables PR integration", () => expect(selectStatusCondition({ kind: "pr_integration", status: installStatus.pr_integration })).toEqual({ kind: "disabled", reason: "integration_none" }));
it("selected integration exposes failures", () => expect(selectStatusCondition({ kind: "pr_integration", status: { selected: "github-cli", health: failed } })).toEqual({ kind: "failed", fix: "Repair it" }));
it("groups checks in payload order followed by profiles, PR and observation", () => {
  const sections = selectStatusSections({ ...installStatus, checks: [healthy, { ...healthy, id: "required", required: true }], agent_profiles: [{ profile_id: "agent", label: "Agent", enabled: true, readiness: healthy }] });
  expect([sections.required.map((entry) => entry.id), sections.optional.map((entry) => entry.label)]).toEqual([["required"], ["Test", "Agent", "PR integration: none", "Observation"]]);
});
function exhaustive(condition: StatusCondition): string {
  switch (condition.kind) {
    case "healthy": case "disabled": case "unavailable": case "failed": return selectConditionTone(condition);
    default: { const impossible: never = condition; return impossible; }
  }
}
it("maps all four condition tones", () => expect([exhaustive({ kind: "healthy" }), exhaustive({ kind: "disabled", reason: "integration_none" }), exhaustive({ kind: "unavailable", fix: "fix" }), exhaustive({ kind: "failed", fix: "fix" })]).toEqual(["success", "muted", "warning", "danger"]));
