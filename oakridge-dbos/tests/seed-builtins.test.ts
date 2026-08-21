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

test("seeding retires the older versions of the built-in it supersedes", async () => {
  // v11 predates the provisioning stage; v13 carries the UNIT_ID binding that
  // addressed every cohort's emit at a unit that does not exist. Offering them
  // beside the current one in the launch form is the trap this closes.
  const { repository, archived } = archivingRepository([
    storedDefinition("id-v11", "dev-flow", 11),
    storedDefinition("id-v13", "dev-flow", 13),
  ]);

  await seedBuiltins(repository);

  expect(archived.sort()).toEqual(["id-v11", "id-v13"]);
});

test("seeding leaves definitions it does not own alone", async () => {
  const { repository, archived } = archivingRepository([
    // Another workflow entirely — not this seed's to retire, whatever its version.
    storedDefinition("id-other", "release-flow", 2),
    // A newer version of the same name: authored deliberately, and ahead of the
    // built-in rather than behind it.
    storedDefinition("id-v15", "dev-flow", 15),
    // Already archived — re-archiving it every boot would be pointless writes.
    storedDefinition("id-v12", "dev-flow", 12, true),
  ]);

  await seedBuiltins(repository);

  expect(archived).toEqual([]);
});
