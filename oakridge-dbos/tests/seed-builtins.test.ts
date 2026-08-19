import { expect, test } from "bun:test";

import type { WorkflowDefinitionId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { seedBuiltins } from "../src/seed/seed-builtins";
import type { WorkflowDefinitionRepository } from "../src/storage/repositories";

test("seeds unmodified v12 through the immutable repository boundary", async () => {
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
  expect(inserted[0]?.version).toBe(12);
  expect(inserted[0]?.graph.stages.build?.stage_type).toBe("delegated_session");
  expect(inserted[0]?.graph.stages.provision_refs?.stage_type).toBe("provision_repository_refs");
});
