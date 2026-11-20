import { expect, test } from "vitest";
import { artifactType, revisionToArtifact } from "../adapters/core";
import { selectVersionedComponent, CURRENT_VIEWERS } from "./artifact-version";
import { OPERATOR_CURRENT_ARTIFACT_VERSIONS } from "../operator-contracts/artifact-versions";
import { resolveViewer, selectViewerItemPaths } from "../artifactRegistry";
import sample from "../__fixtures__/v2-adapter-sample.json";
import brief from "./__fixtures__/build-items-brief.json";
import currentAnalysis from "../__fixtures__/current-analysis.json";
import currentSpec from "../__fixtures__/current-spec.json";
import currentPlan from "../__fixtures__/current-plan.json";
import currentBrief from "../__fixtures__/current-brief.json";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
test.each(["analysis_body", "spec_body", "plan_body", "brief_body", "assessment_body"] as const)("an unversioned or unknown %s revision opens in its current viewer", (schema) => {
  expect([artifactType(schema).component_id, artifactType(schema, "unknown").component_id]).toEqual([CURRENT_VIEWERS[schema], CURRENT_VIEWERS[schema]]);
});
test.each([
  ["analysis_body", currentAnalysis, ["/requirements/0/findings/0", "/requirements/0/findings/1", "/requirements/1/findings/0", "/requirements/1/findings/1", "/requirements/2/findings/0"]],
  ["spec_body", currentSpec, ["/requirements/0", "/requirements/1", "/requirements/2"]],
  ["plan_body", currentPlan, ["/cohorts/0/allocations/0", "/cohorts/1/allocations/0", "/cohorts/2/allocations/0"]],
  ["brief_body", currentBrief, ["/build_items/0", "/build_items/1"]],
] as const)("registered current %s viewers have contract item paths", (schema, body, paths) => {
  const version = OPERATOR_CURRENT_ARTIFACT_VERSIONS[schema].version;
  const Viewer = resolveViewer(selectVersionedComponent({ schema, version }));
  expect(artifactType(schema, version).component_id).toBe(CURRENT_VIEWERS[schema]);
  expect(Viewer && selectViewerItemPaths(Viewer, body)).toEqual(paths);
});
test("historical named declaration hashes retain legacy readers", () => {
  const legacy = [
    ["analysis_body", "artifact-schema/v1:4847489074cebfe24f7ecdd9024b351f26ccac021f3f10ce2c788bfa8a5d39e2"],
    ["plan_body", "artifact-schema/v1:66a1e9afac28cdb4b4db8fa8e78c9df02da4ddba1952d189279d22025a4ef79e"],
    ["brief_body", "artifact-schema/v1:c1303586cb5531a0c0aed8a282c0ad68917d94c94834d336705373166479951f"],
  ];
  expect(legacy.map(([schema, version]) => selectVersionedComponent({ schema, version }))).toEqual([null, null, null]);
});
test("revision metadata is preserved independently of its body", () => {
  const original = sample.artifact as unknown as OperatorArtifactDetail;
  const artifact = { ...original, schema: "spec_body", revisions: original.revisions.map((revision) => ({ ...revision, artifact_schema_version: OPERATOR_CURRENT_ARTIFACT_VERSIONS.spec_body.version, body: currentSpec })) };
  const unit = sample.units.find((entry) => entry.unit_id === original.unit_id) as unknown as OperatorUnitView;
  const parsed = revisionToArtifact(artifact, unit);
  expect(parsed.ok && parsed.value.revisions[0]).toMatchObject({ artifact_schema_version: OPERATOR_CURRENT_ARTIFACT_VERSIONS.spec_body.version, component_id: "dev-current-spec-viewer", body: currentSpec });
});
test("a body the current viewer cannot read falls back to the contract view", async () => {
  const { isReadableViewer } = await import("../artifactRegistry");
  const studyPlan = { question: "Which model?", hypotheses: [], cases: [], groups: [], outcomes: [], decision_rule: [], models: [] };
  const Viewer = resolveViewer(artifactType("plan_body", "study-version").component_id);
  expect(Viewer && isReadableViewer(Viewer, studyPlan)).toBe(false);
});
test("brief reader's current branch is explicit and legacy calls retain their shape", async () => {
  const { readBuildBrief } = await import("./build-brief");
  const current = readBuildBrief(currentBrief, { version: "fixture-current", registrations: [{ schema: "brief_body", version: "fixture-current", component_id: "dev-current-brief-viewer" }] });
  expect([current?.shape, readBuildBrief(brief)?.shape]).toEqual(["current", "build_items"]);
});
