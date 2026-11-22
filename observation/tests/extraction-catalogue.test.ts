import { expect, test } from "bun:test";
import { ARTIFACT_KEY_LIST } from "../src/producers/oakridge/artifact-versions";
import { OAKRIDGE_REGISTRATIONS, selectRegistration } from "../src/producers/oakridge/catalogue";
import { createFeed, developmentKeys, integration, scratchDatabase, tenant } from "./grading-fixture";
import { listRunItems } from "../src/storage/projection-store";

test("every launchable declaration has exactly one registration and a documented selector for each extractor", async () => {
  expect(OAKRIDGE_REGISTRATIONS.map(({ key }) => key)).toEqual(expect.arrayContaining(ARTIFACT_KEY_LIST));
  expect(new Set(OAKRIDGE_REGISTRATIONS.map(({ key }) => key)).size).toBe(OAKRIDGE_REGISTRATIONS.length);
  expect(OAKRIDGE_REGISTRATIONS).toHaveLength(ARTIFACT_KEY_LIST.length);
  const document = await Bun.file(new URL("../../docs/observation-extraction-catalogue.md", import.meta.url)).text();
  for (const { extractors } of OAKRIDGE_REGISTRATIONS) for (const extractor of extractors) {
    const row = "| `" + extractor.artifact_kind + "` | `" + extractor.item_selector + "` |";
    expect(document).toContain(row);
  }
});

test("same artifact and digest select separate registrations by definition and stage", () => {
  const key = developmentKeys.spec;
  const [original, alternate] = ["one", "two"].map((definition_id) => ({ key: { ...key, definition_id }, extractors: [] }));
  const registration = (definition_id: string, stage = key.stage as string) => selectRegistration({
    definition_id, stage, artifact_kind: key.artifact, artifact_schema_version: key.schema_version,
  }, [original!, alternate!]);
  expect(registration("one")).toBe(original);
  expect(registration("two")).toBe(alternate);
  expect(registration("two", "other")).toBeUndefined();
});

for (const mode of ["schema", "definition"] as const) integration(`an unregistered ${mode} records one actionable issue and no items`, async () =>
  scratchDatabase(async (db) => {
    const key = developmentKeys.spec;
    const definition_id = mode === "definition" ? "superseded" : key.definition_id;
    const schema_version = mode === "schema" ? "unregistered" : key.schema_version;
    const feed = createFeed(db);
    await feed.revision({ artifact_kind: key.artifact, stage: key.stage, revision_id: "spec:1", definition_id, schema_version, body: {} });
    const result = await listRunItems(db, tenant, "run-1", { limit: 20, offset: 0 });
    expect(result.items).toEqual([]);
    expect(result.issues.items).toMatchObject([{
      kind: "unregistered_declaration", is_retriable: false,
      detail: `no extractor registration for (definition_id=${definition_id}, stage_key=${key.stage}, artifact_key=${key.artifact}, resolved_schema_version=${schema_version})`,
    }]);
  }));

integration("extractor definitions persist separately when the artifact and digest are shared", async () => scratchDatabase(async (db) => {
  const { deliverSourceEvent } = await import("../src/storage/capture-store");
  const { withTenant } = await import("../src/storage/database");
  const { fixtureDelivery, revisionOutcome } = await import("./grading-fixture");
  const key = developmentKeys.spec;
  const extractors = selectRegistration({ definition_id: key.definition_id, stage: key.stage,
    artifact_kind: key.artifact, artifact_schema_version: key.schema_version })!.extractors;
  const registrations = ["first", "second"].map((definition_id) => ({ key: { ...key, definition_id }, extractors }));
  const context = { extraction: { definitions: (candidate: Parameters<typeof selectRegistration>[0]) =>
    selectRegistration(candidate, registrations)?.extractors, revisionLink: () => null }, configuration: { pins: [] } };
  let cursor = { commit_txid: "0", event_id: "" };
  for (const { key: { definition_id } } of registrations) {
    const event = revisionOutcome({ definition_id, schema_version: key.schema_version, stage: key.stage, artifact_kind: key.artifact,
      revision_id: `${definition_id}:spec:1`, body: { requirements: [{ id: definition_id, analysis_finding_ids: [] }] } });
    const delivery = fixtureDelivery(tenant, event, cursor);
    expect((await deliverSourceEvent(db, tenant, delivery, context)).status).toBe(200);
    cursor = delivery.cursor;
  }
  const definitions = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.extractor_definition")
    .select(["definition_id", "artifact_kind", "schema_version"]).orderBy("definition_id").execute());
  expect(definitions.map((row) => row.definition_id)).toEqual(["first", "second"]);
  const items = (await listRunItems(db, tenant, "run-1", { limit: 10, offset: 0 })).items;
  expect(items.map((row) => [row.definition_id, row.producer_local_id])).toEqual([["first", "first"], ["second", "second"]]);
}));
