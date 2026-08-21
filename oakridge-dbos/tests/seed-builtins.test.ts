import { expect, test } from "bun:test";

import type { WorkflowDefinitionId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { seedBuiltins } from "../src/seed/seed-builtins";
import type { WorkflowDefinitionRepository } from "../src/storage/repositories";

test("seeds unmodified v14 through the immutable repository boundary", async () => {
  const inserted: WorkflowDefinition[] = [];
  const repository: WorkflowDefinitionRepository = {
    async insert_immutable(definition) { inserted.push(definition); return definition; },
    async find_by_id(_id: WorkflowDefinitionId) { return null; },
    async find_by_name_version(_name: string, _version: number) { return null; },
    async list() { return inserted; },
    async set_archived() { return null; },
  };
  await seedBuiltins(repository);
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.version).toBe(14);
  expect(inserted[0]?.graph.stages.build?.stage_type).toBe("delegated_session");
  expect(inserted[0]?.graph.stages.provision_refs?.stage_type).toBe("provision_repository_refs");
});

/**
 * A stored definition, as the repository hands one back. Only the fields the
 * superseding rule reads are real; the graph is never looked at here.
 */
function storedDefinition(
  id: string,
  name: string,
  version: number,
  archived = false,
): WorkflowDefinition {
  return { id, name, version, archived, created_at: "2026-01-01T00:00:00Z", graph: { stages: {} } } as unknown as WorkflowDefinition;
}

function archivingRepository(existing: readonly WorkflowDefinition[]): {
  repository: WorkflowDefinitionRepository;
  archived: string[];
} {
  const archived: string[] = [];
  const stored = [...existing];
  const repository: WorkflowDefinitionRepository = {
    async insert_immutable(definition) { stored.push(definition); return definition; },
    async find_by_id(_id: WorkflowDefinitionId) { return null; },
    async find_by_name_version(_name: string, _version: number) { return null; },
    async list() { return stored; },
    async set_archived(id) { archived.push(id); return null; },
  };
  return { repository, archived };
}

// The ids this seed has actually shipped, as stored rows would carry them.
const SHIPPED_V11 = "ef2b47a4-d1bd-44ee-840a-e4f7b27570db";
const SHIPPED_V13 = "7c4a1f38-9b52-4d6e-8a17-3e0c5b9d24f1";

test("seeding retires the shipped versions it supersedes", async () => {
  // v11 predates the provisioning stage; v13 carries the UNIT_ID binding that
  // addressed every cohort's emit at a unit that does not exist. Offering them
  // beside the current one in the launch form is the trap this closes.
  const { repository, archived } = archivingRepository([
    storedDefinition(SHIPPED_V11, "dev-flow", 11),
    storedDefinition(SHIPPED_V13, "dev-flow", 13),
  ]);

  await seedBuiltins(repository);

  expect(archived.sort()).toEqual([SHIPPED_V13, SHIPPED_V11].sort());
});

test("seeding leaves a definition it did not ship alone, whatever it is called", async () => {
  // `POST /workflow_defs` reserves no name and a definition records no author,
  // so an operator can author one called `dev-flow` at an unused version. It is
  // theirs. Matching on name and version could not tell it from a built-in.
  const { repository, archived } = archivingRepository([
    storedDefinition("11111111-2222-4333-8444-555555555555", "dev-flow", 10),
    storedDefinition("99999999-8888-4777-8666-555555555555", "release-flow", 2),
  ]);

  await seedBuiltins(repository);

  expect(archived).toEqual([]);
});

test("seeding does not retire a shipped version ahead of the one it seeds", async () => {
  // Rolling the seed back to an older build must not retire the newer version
  // still on offer — the operator downgraded the binary, not the workflow.
  const { repository, archived } = archivingRepository([
    storedDefinition(SHIPPED_V13, "dev-flow", 99),
  ]);

  await seedBuiltins(repository);

  expect(archived).toEqual([]);
});
