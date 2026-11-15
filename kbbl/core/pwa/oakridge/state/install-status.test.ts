import { expect, test } from "vitest";
import { installStatus } from "../__fixtures__/install-status";
import { selectAccessModeLabel, selectCheckTone, selectLaunchBlock } from "./install-status";
import { MANUAL_MERGE_INDICATION, selectManualMergeIndication } from "./manual-merge";
import definitionFixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
const definition = definitionFixture.definition as unknown as OperatorDefinitionDetail;
test("all three access modes have operator labels", () => {
  expect((["local", "authenticated_network", "insecure_network"] as const).map((kind) => selectAccessModeLabel({ kind, bind_host: "localhost" }))).toEqual(["Local", "Authenticated network", "Insecure network"]);
});
test("only required failure has blocking styling", () => {
  expect(selectCheckTone(installStatus.observation.availability)).toBe("muted");
  const failure = { kind: "failed" as const, id: "kbbl", label: "kbbl", required: true, detail: "Offline", fix: "Start kbbl" };
  expect(selectCheckTone(failure)).toBe("danger");
  expect(selectCheckTone({ ...failure, required: false })).toBe("muted");
});
test("launch block selector returns the served entry and null for other definitions", () => {
  const block = { definition_id: definition.definition_id, definition_name: "development", error: { kind: "integration_none" as const, integration: "none" as const, definition_id: definition.definition_id, detail: "PR integration required", fix: "Select an integration" } };
  const status = { ...installStatus, launch_blocks: [block] };
  expect(selectLaunchBlock(status, definition.definition_id)).toBe(block);
  expect(selectLaunchBlock(status, "other")).toBeNull();
});
for (const stage of ["cohort", "integration"]) test(`github-cli ${stage} merge indication persists independent of unit state`, () => {
  expect(selectManualMergeIndication({ run: { pr_integration: "github-cli" }, unit: { stage }, definition })).toBe(true);
});
for (const pr_integration of ["gated-review", "none", null] as const) test(`${pr_integration} has no manual merge indication`, () => {
  expect(selectManualMergeIndication({ run: { pr_integration }, unit: { stage: "cohort" }, definition })).toBe(false);
});
test("non-merge stages have no indication", () => {
  expect(selectManualMergeIndication({ run: { pr_integration: "github-cli" }, unit: { stage: "plan" }, definition })).toBe(false);
  expect(MANUAL_MERGE_INDICATION).toContain("Confirm merged");
});

import { parseInstallStatus } from "../adapters/install-status";
test("status decoder preserves the served verdict without recomputation", () => {
  const served = { ...installStatus, installation_failed: true };
  expect(parseInstallStatus(served)).toEqual({ ok: true, value: served });
  expect(parseInstallStatus({ ...served, checks: [{}] }).ok).toBe(false);
});
