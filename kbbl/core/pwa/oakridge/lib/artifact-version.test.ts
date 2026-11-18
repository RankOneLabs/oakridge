import { expect, test } from "vitest";
import { artifactType, revisionToArtifact } from "../adapters/core";
import { selectVersionedComponent, CURRENT_VIEWERS } from "./artifact-version";
import { OPERATOR_CURRENT_ARTIFACT_VERSIONS } from "../operator-contracts/artifact-versions";
import { resolveViewer, selectViewerItemPaths } from "../artifactRegistry";
import { SpecAnalysisViewer } from "../components/molecules/SpecAnalysisViewer";
import { TasksViewer } from "../components/molecules/TasksViewer";
import { PlanViewer } from "../components/molecules/PlanViewer";
import { BuildBriefViewer } from "../components/molecules/BuildBriefViewer";
import { AssessmentReview } from "../components/organisms/AssessmentReview";
import sample from "../__fixtures__/v2-adapter-sample.json";
import plan from "./__fixtures__/id-linked-plan.json";
import brief from "./__fixtures__/build-items-brief.json";
import assessment from "./__fixtures__/id-linked-assessment.json";
import currentAnalysis from "../__fixtures__/current-analysis.json";
import currentSpec from "../__fixtures__/current-spec.json";
import currentPlan from "../__fixtures__/current-plan.json";
import currentBrief from "../__fixtures__/current-brief.json";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
const legacyAnalysis = { summary: "Legacy", findings: [{ id: "F1", description: "Old", severity: "info" }], requirements: [], risks: [], proposed_spec_updates: [], source_spec_refs: [] };
test.each([
  ["analysis_body", SpecAnalysisViewer, legacyAnalysis, ["/findings/0"]],
  ["tasks_body", TasksViewer, { tasks: [{ id: "T1", description: "Legacy task", requirement_ids: [] }] }, ["/tasks/0"]],
  ["plan_body", PlanViewer, plan, plan.cohorts.flatMap((c, i) => c.acceptance_criteria.map((_, j) => `/cohorts/${i}/acceptance_criteria/${j}`))],
  ["brief_body", BuildBriefViewer, brief, brief.build_items.map((_, i) => `/build_items/${i}`)],
  ["assessment_body", AssessmentReview, assessment, ["/findings/0"]],
] as const)("historical and unknown %s versions keep their reader and item paths", (schema, Viewer, body, paths) => {
  const copy = structuredClone(body);
  expect(resolveViewer(artifactType(schema).component_id)).toBe(Viewer);
  expect(resolveViewer(artifactType(schema, "unknown").component_id)).toBe(Viewer);
  expect(selectViewerItemPaths(Viewer, body)).toEqual(paths);
  expect(body).toEqual(copy);
});
test.each([
  ["analysis_body", currentAnalysis, ["/requirements/0/findings/0", "/requirements/0/findings/1", "/requirements/1/findings/0", "/requirements/1/findings/1", "/requirements/2/findings/0"]],
  ["spec_body", currentSpec, ["/requirements/0", "/requirements/1", "/requirements/2"]],
  ["plan_body", currentPlan, ["/cohorts/0/allocations/0", "/cohorts/1/allocations/0", "/cohorts/2/allocations/0"]],
  ["brief_body", currentBrief, ["/build_items/0", "/build_items/1"]],
] as const)("registered current %s viewers have contract item paths", (schema, body, paths) => {
  const version = OPERATOR_CURRENT_ARTIFACT_VERSIONS[schema].version;
  const Viewer = resolveViewer(selectVersionedComponent(schema, version));
  expect(artifactType(schema, version).component_id).toBe(CURRENT_VIEWERS[schema]);
  expect(Viewer && selectViewerItemPaths(Viewer, body)).toEqual(paths);
});
test("historical named declaration hashes retain legacy readers", () => {
  const legacy = [
    ["analysis_body", "artifact-schema/v1:4847489074cebfe24f7ecdd9024b351f26ccac021f3f10ce2c788bfa8a5d39e2"],
    ["plan_body", "artifact-schema/v1:66a1e9afac28cdb4b4db8fa8e78c9df02da4ddba1952d189279d22025a4ef79e"],
    ["brief_body", "artifact-schema/v1:c1303586cb5531a0c0aed8a282c0ad68917d94c94834d336705373166479951f"],
  ];
  expect(legacy.map(([schema, version]) => selectVersionedComponent(schema, version))).toEqual([null, null, null]);
});
test("revision metadata is preserved independently of its body", () => {
  const original = sample.artifact as unknown as OperatorArtifactDetail;
  const artifact = { ...original, schema: "spec_body", revisions: original.revisions.map((revision) => ({ ...revision, artifact_schema_version: OPERATOR_CURRENT_ARTIFACT_VERSIONS.spec_body.version, body: currentSpec })) };
  const unit = sample.units.find((entry) => entry.unit_id === original.unit_id) as unknown as OperatorUnitView;
  const parsed = revisionToArtifact(artifact, unit);
  expect(parsed.ok && parsed.value.revisions[0]).toMatchObject({ artifact_schema_version: OPERATOR_CURRENT_ARTIFACT_VERSIONS.spec_body.version, component_id: "dev-current-spec-viewer", body: currentSpec });
});
test("a refused unknown body uses the raw fallback without changing the legacy reader", async () => {
  const { isReadableViewer } = await import("../artifactRegistry");
  const Viewer = resolveViewer(artifactType("analysis_body", "unrecognized").component_id);
  expect(Viewer && isReadableViewer(Viewer, currentAnalysis)).toBe(false);
});
test("brief reader's current branch is explicit and legacy calls retain their shape", async () => {
  const { readBuildBrief } = await import("./build-brief");
  const current = readBuildBrief(currentBrief, "fixture-current", [{ schema: "brief_body", version: "fixture-current", component_id: "dev-current-brief-viewer" }]);
  expect([current?.shape, readBuildBrief(brief)?.shape]).toEqual(["current", "build_items"]);
});
