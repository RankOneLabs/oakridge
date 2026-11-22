import { expect, test } from "bun:test";
import { artifactSchemaVersion, runInputSchemaVersion } from "../src/adapters/observation-schema-version";
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
test("unresolvable and recursive names produce no artifact version", () => {
  expect([
    version({ artifact: { kind: "named", schema: "missing" }, schemas }),
    version({ artifact: named, schemas: { ...schemas, analysis_body: named } }),
  ]).toEqual([null, null]);
});

test("each launchable development and study artifact and run input use resolved versions", async () => {
  const { CoreClient, compileDefinition } = await import("../src/core-client/client");
  const { readLaunchableCatalog } = await import("../src/runtime/definition-store");
  const core = CoreClient.start();
  if (!core.ok) throw new Error(JSON.stringify(core.error));
  try {
    const catalog = readLaunchableCatalog();
    if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
    for (const key of ["development", "study"] as const) {
      const compiled = await compileDefinition(core.value, catalog.value[key].definition_id);
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
      const workflow = compiled.value.checked_program.workflow;
      const inputVersion = runInputSchemaVersion(workflow);
      if (!inputVersion.ok) throw new Error(JSON.stringify(inputVersion.error));
      expect(inputVersion.value).toMatch(/^artifact-schema\/v2:[a-f0-9]{64}$/);
      for (const [stage, definition] of Object.entries(workflow.stages)) {
        for (const artifact of Object.keys(definition.artifacts)) {
          expect(artifactSchemaVersion(compiled.value, stage, artifact)).toMatch(/^artifact-schema\/v2:[a-f0-9]{64}$/);
        }
      }
    }
  } finally { core.value.close(); }
});

test("run inputs expand named fields before hashing", () => {
  const original = { input: { kind: "record", fields: { requirement: { kind: "named", schema: "requirement" } } }, schemas } satisfies Pick<ParsedWorkflow, "input" | "schemas">;
  const revised = { ...original, schemas: { ...schemas, requirement: { kind: "record" as const, fields: { id: { kind: "ident" as const } } } } };
  const previousVersion = runInputSchemaVersion(original);
  const revisedVersion = runInputSchemaVersion(revised);
  if (!previousVersion.ok || !revisedVersion.ok) throw new Error("expected valid run input schemas");
  expect(previousVersion.value).not.toBe(revisedVersion.value);
});
