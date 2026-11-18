import { expect, test } from "bun:test";
import { compileWorkflow, CoreClient } from "../src/core-client/client";
import { readLaunchableCatalog, resolveDefinition, type DefinitionId } from "../src/runtime/definition-store";
import { artifactSchemaVersions, declarationDigest, parsedArtifactSchemaVersion } from "../src/adapters/observation-schema-version";
import { DEVELOPMENT_ARTIFACT_VERSIONS } from "../src/adapters/development-artifact-versions";
import type { ParsedWorkflow } from "../src/core-client/core-types";
import { selectRevisionViews } from "../src/projections/unit-view";
import { selectArtifactDetail } from "../src/projections/artifact-view";
import type { RunRead } from "../src/storage/read-store";
import type { ArtifactRevisionRecord } from "../src/storage/schema-records";
const startup = CoreClient.start();
if (!startup.ok) throw new Error(JSON.stringify(startup.error));
const core = startup.value;
async function compiled(id: DefinitionId) {
  const resolved = resolveDefinition(id);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));
  const result = await compileWorkflow(core, { workflow: resolved.value.source, prompts: resolved.value.prompts, operations: resolved.value.operations });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value.workflow;
}
const catalog = readLaunchableCatalog();
if (!catalog.ok || !catalog.value.development) throw new Error("no current development definition");
const current = await compiled(catalog.value.development.definition_id);
const historical = await compiled("74de304c8c29fc50ac3596817a2aed2ffb14846ccb8ecb7ef59f91127b7f87f4" as DefinitionId);
core.close();
const artifacts = [
  ["analysis_body", "analysis", "analysis"], ["spec_body", "analysis", "spec"],
  ["plan_body", "planning", "plan"], ["brief_body", "brief", "brief"],
] as const;
test.each(artifacts)("%s current identity is generated from its pinned reachable types", (schema, stage, artifact) => {
  const version = parsedArtifactSchemaVersion(current, stage, artifact);
  expect(version).toBe(DEVELOPMENT_ARTIFACT_VERSIONS[schema].version);
  expect(version).not.toBe(declarationDigest({ kind: "named", schema }));
});
test("historical pinned analysis, plan and brief retain their original hashes", () => {
  const declarations = Object.entries(historical.stages).flatMap(([stage, value]) => Object.entries(value.artifacts).map(([artifact, declaration]) => ({ stage, artifact, schema: declaration.schema })));
  expect(declarations.map(({ stage, artifact }) => parsedArtifactSchemaVersion(historical, stage, artifact))).toEqual(declarations.map(({ schema }) => declarationDigest(schema)));
});
test("editing a nested finding type changes analysis identity without changing other artifacts", () => {
  const changed: ParsedWorkflow = { ...current, schemas: { ...current.schemas, finding_evidence: { kind: "text" } } };
  expect(parsedArtifactSchemaVersion(changed, "analysis", "analysis")).not.toBe(parsedArtifactSchemaVersion(current, "analysis", "analysis"));
  expect(parsedArtifactSchemaVersion(changed, "planning", "plan")).toBe(parsedArtifactSchemaVersion(current, "planning", "plan"));
});
test("unrelated types and prompt-only edits keep the artifact identity", () => {
  const changed: ParsedWorkflow = { ...current, schemas: { ...current.schemas, unused: { kind: "integer" } } };
  expect(parsedArtifactSchemaVersion(changed, "analysis", "analysis")).toBe(parsedArtifactSchemaVersion(current, "analysis", "analysis"));
});
test("operator list and artifact detail revisions share the pinned capture version", () => {
  const revision = { id: "run/analysis:spec:1", run_id: "run", unit_id: "run/analysis", artifact: "spec", seq: 1, body: { objective: "Pinned" }, by_id: null,
    predecessor_id: null, subject: null, created_at: new Date(0) } as ArtifactRevisionRecord;
  const read = { run: { input: { spec: "Original" } }, units: [{ id: revision.unit_id, stage: "analysis" }], revisions: [revision], attempts: [], decisions: [],
    definition: { parsed_workflow: current, artifact_schema_versions: artifactSchemaVersions(current) } } as unknown as RunRead;
  const list = selectRevisionViews({ revisions: [revision], attempts: [], versions: artifactSchemaVersions(current), stage: "analysis" });
  const detail = selectArtifactDetail(read, { unit_id: revision.unit_id, artifact: "spec" });
  expect([list[0]?.artifact_schema_version, detail?.revisions[0]?.artifact_schema_version]).toEqual([DEVELOPMENT_ARTIFACT_VERSIONS.spec_body.version, DEVELOPMENT_ARTIFACT_VERSIONS.spec_body.version]);
  expect(list[0]?.body).toEqual({ objective: "Pinned" });
});

test("backend and observation generated manifests stay synchronized", async () => {
  const observation = await import("../../observation/src/producers/oakridge/artifact-versions");
  expect(observation.DEVELOPMENT_ARTIFACT_VERSIONS).toEqual(DEVELOPMENT_ARTIFACT_VERSIONS);
});

test("current spec captures preserve the exact analysis revision ids supplied by the publisher", async () => {
  const { mapObservationEvent } = await import("../src/adapters/observation-mapping");
  const row = { id: "event", run_id: "run", payload: { kind: "revision_published", unit: "run/analysis", artifact: "spec", body: {} },
    created_at: new Date(0) } as import("../src/storage/read-store").CommittedEventRow<import("../src/storage/json-column-types").CoreEvent>;
  const definition = { definition_id: catalog.value.development!.definition_id, checked_program: { workflow: current } } as unknown as import("../src/storage/read-store").PinnedDefinitionRead;
  const capture = mapObservationEvent({ row, definition, namespace: "test", stage: "analysis", revision_sequence: 1, run_config: null, analysis_revision_id: "run/analysis:analysis:2" });
  expect(capture.kind === "artifact_revision" && capture.revision.source.analysis_revision_ids).toEqual(["oakridge:test:run/analysis:analysis:2"]);
});
