import { expect, test } from "bun:test";
import { artifactSchemaVersion, declarationDigest } from "../src/adapters/observation-schema-version";
import type { ParsedWorkflow, Type } from "../src/core-client/core-types";
import type { PinnedDefinitionRead } from "../src/storage/read-store";

interface ContractSchema {
  readonly artifact: Type;
  readonly schemas: NonNullable<ParsedWorkflow["schemas"]>;
  readonly has_tasks?: boolean;
  readonly definition_id?: string;
}
function definition(input: ContractSchema): PinnedDefinitionRead {
  return { definition_id: input.definition_id ?? "definition", checked_program: { workflow: {
    schemas: input.schemas, stages: { analysis: { artifacts: {
      spec: { schema: { kind: "named", schema: "spec_body" } },
      analysis: { schema: input.artifact }, blocker: { schema: { kind: "record", fields: { text: { kind: "text" } } } },
      ...(input.has_tasks ? { tasks: { schema: { kind: "named", schema: "tasks_body" } } } : {}),
    } } },
  } } } as unknown as PinnedDefinitionRead;
}
const named: Type = { kind: "named", schema: "analysis_body" };
const schemas: NonNullable<ParsedWorkflow["schemas"]> = {
  spec_body: { kind: "record", fields: { requirements: { kind: "list", item: { kind: "text" } } } },
  analysis_body: { kind: "record", fields: { requirements: { kind: "list", item: { kind: "optional", value: { kind: "named", schema: "requirement" } } } } },
  requirement: { kind: "record", fields: { id: { kind: "ident" }, text: { kind: "text" } } },
};
const version = (input: ContractSchema) => artifactSchemaVersion(definition(input), "analysis", "analysis");
test("nested named schema body edits change the current artifact version", () => {
  expect(version({ artifact: named, schemas })).not.toBe(version({ artifact: named, schemas: {
    ...schemas, requirement: { kind: "record", fields: { id: { kind: "ident" }, text: { kind: "integer" } } },
  } }));
});
test("resolved versions ignore alias names, prompt/definition changes and unrelated schemas", () => {
  const original = version({ artifact: named, schemas });
  expect([
    version({ artifact: schemas.analysis_body!, schemas }),
    version({ artifact: named, schemas, definition_id: "changed-prompts" }),
    version({ artifact: named, schemas: { ...schemas, unrelated: { kind: "integer" } } }),
    version({ artifact: { kind: "named", schema: "renamed" }, schemas: { ...schemas, renamed: schemas.analysis_body! } }),
  ]).toEqual([original, original, original, original]);
});
test("historical contracts retain their exact named-declaration digests on replay", () => {
  expect(version({ artifact: named, schemas, has_tasks: true })).toBe(declarationDigest(named));
});
test("the epoch gives unchanged current blockers a version distinct from historical blockers", () => {
  const current = artifactSchemaVersion(definition({ artifact: named, schemas }), "analysis", "blocker");
  const legacy = artifactSchemaVersion(definition({ artifact: named, schemas, has_tasks: true }), "analysis", "blocker");
  expect([current?.split(":")[0], legacy?.split(":")[0], current === legacy]).toEqual(["artifact-schema/v2", "artifact-schema/v1", false]);
});
test("unresolvable and recursive names produce no artifact version", () => {
  expect([
    version({ artifact: { kind: "named", schema: "missing" }, schemas }),
    version({ artifact: named, schemas: { ...schemas, analysis_body: named } }),
  ]).toEqual([null, null]);
});

test("the real pinned requirement definition emits every published current extractor version", async () => {
  const { CoreClient, compileDefinition } = await import("../src/core-client/client");
  const { readLaunchableCatalog } = await import("../src/runtime/definition-store");
  const { CURRENT_SCHEMA_VERSIONS, oakridgeCatalogue } = await import("../../observation/src/producers/oakridge/catalogue");
  const core = CoreClient.start();
  if (!core.ok) throw new Error(JSON.stringify(core.error));
  try {
    const catalog = readLaunchableCatalog();
    if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
    const compiled = await compileDefinition(core.value, catalog.value.development.definition_id);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
    for (const [stage, definition] of Object.entries(compiled.value.checked_program.workflow.stages)) {
      for (const kind of Object.keys(definition.artifacts)) {
        if (!Object.hasOwn(CURRENT_SCHEMA_VERSIONS, kind)) continue;
        const version = artifactSchemaVersion(compiled.value, stage, kind);
        expect(version).toBe(CURRENT_SCHEMA_VERSIONS[kind as keyof typeof CURRENT_SCHEMA_VERSIONS]);
        expect(oakridgeCatalogue(kind, version!).length).toBeGreaterThan(0);
      }
    }
  } finally { core.value.close(); }
});

test("the historical pinned definition keeps v1 versions and legacy extractors", async () => {
  const { CoreClient, compileDefinition } = await import("../src/core-client/client");
  const { oakridgeCatalogue } = await import("../../observation/src/producers/oakridge/catalogue");
  const core = CoreClient.start();
  if (!core.ok) throw new Error(JSON.stringify(core.error));
  try {
    const compiled = await compileDefinition(core.value, "74de304c8c29fc50ac3596817a2aed2ffb14846ccb8ecb7ef59f91127b7f87f4" as PinnedDefinitionRead["definition_id"]);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
    for (const [stage, definition] of Object.entries(compiled.value.checked_program.workflow.stages)) {
      for (const [kind, declaration] of Object.entries(definition.artifacts)) {
        const version = artifactSchemaVersion(compiled.value, stage, kind);
        expect(version).toBe(declarationDigest(declaration.schema));
        expect(oakridgeCatalogue(kind, version!).map((definition) => definition.extractor_id))
          .toEqual(oakridgeCatalogue(kind, "development-v1").map((definition) => definition.extractor_id));
      }
    }
  } finally { core.value.close(); }
});
