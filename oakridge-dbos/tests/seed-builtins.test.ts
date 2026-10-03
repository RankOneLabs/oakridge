import { expect, test } from "bun:test";
import type { WorkflowDefinition } from "../src/domain/dev-flow-v15";
import type { V15PromptBundle } from "../src/compiler/compile-v15";
import { seedBuiltins, type V15DefinitionSeedRepository } from "../src/seed/seed-builtins";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { PostgresWorkflowDefinitionRepository } from "../src/storage/postgres-workflow-definitions";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { applyMigrations } from "../src/storage/migrate";
import { createScratchDatabase } from "./support/durable-database";

interface SeededDefinition { readonly definition: WorkflowDefinition; readonly prompts: V15PromptBundle }

test("seeding passes the canonical definition and all eighteen prompts to persistence", async () => {
  const inserted: SeededDefinition[] = [];
  const repository: V15DefinitionSeedRepository = {
    async insert_v15_immutable(definition, prompts) { inserted.push({ definition, prompts }); },
  };
  await seedBuiltins(repository);
  expect(inserted[0]?.definition).toEqual(await Bun.file(new URL("../../workflow-config/definitions/dev_flow_v15.json", import.meta.url)).json());
  expect(inserted[0]?.prompts.entries).toHaveLength(18);
});

test("two boots produce the same definition and content-addressed bundle", async () => {
  const inserted: SeededDefinition[] = [];
  const repository: V15DefinitionSeedRepository = {
    async insert_v15_immutable(definition, prompts) { inserted.push({ definition, prompts }); },
  };
  await seedBuiltins(repository);
  await seedBuiltins(repository);
  expect(inserted[1]).toEqual(inserted[0]);
});

test("seeding propagates a persistence conflict instead of substituting a graph definition", async () => {
  await expect(seedBuiltins({ async insert_v15_immutable() { throw new Error("immutable conflict"); } })).rejects.toThrow("immutable conflict");
});

test("PostgreSQL stores canonical definition data and enforces version immutability", async () => {
  const scratch = await createScratchDatabase("oakridge_v15_definition_seed");
  if (!scratch.ok) throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    await applyMigrations(sql);
    const repository = new PostgresWorkflowDefinitionRepository(sql, createDevFlowAdapterRegistry());
    await seedBuiltins(repository);
    await seedBuiltins(repository);
    const rows = await sql.query<{ readonly definition: WorkflowDefinition; readonly id: string }>("SELECT id::text,definition FROM oakridge.workflow_definition WHERE name=$1", ["dev_flow_v15"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toEqual(await Bun.file(new URL("../../workflow-config/definitions/dev_flow_v15.json", import.meta.url)).json());
    const seeded: SeededDefinition[] = [];
    await seedBuiltins({ async insert_v15_immutable(definition, prompts) { seeded.push({ definition, prompts }); } });
    const item = seeded[0]!;
    const changed = structuredClone(item.definition);
    changed.stages.implementation.max_active_cohorts = 2;
    await expect(repository.insert_v15_immutable(changed, item.prompts)).rejects.toThrow("immutable stored content");
    const bundles = await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.workflow_definition_prompt_bundle", []);
    expect(bundles[0]?.count).toBe("1");
  } finally {
    await sql.close();
    await scratch.value.drop();
  }
});
