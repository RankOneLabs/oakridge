import { expect, test } from "bun:test";

import type { Project } from "../src/domain/projects";
import type { ProjectId, WorkflowDefinitionId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { createConfigurationApp } from "../src/http/configuration";
import type { ProjectRepository, WorkflowDefinitionRepository } from "../src/storage/repositories";

const project: Project = { id: "00000000-0000-4000-8000-000000000001" as ProjectId, name: "Oakridge", repo_dir: "/code/oakridge", created_at: "2026-08-15T12:00:00Z", forge_repository: null, base_branch: null };
const definition: WorkflowDefinition = { id: "00000000-0000-4000-8000-000000000002" as WorkflowDefinitionId, name: "flow", version: 1, archived: false, created_at: "2026-08-15T12:00:00Z", graph: { stages: {}, edges: [] } };

const fixture = (generatedId = project.id as string, identity: Project["forge_repository"] = null, baseBranch: string | null = null, shouldFailProjectInsert = false) => {
  const projects: Project[] = [];
  const definitions: WorkflowDefinition[] = [];
  const projectRepository: ProjectRepository = {
    insert: async (input) => { if (shouldFailProjectInsert) throw new Error("storage unavailable"); const created = { ...input }; projects.push(created); return created; },
    list: async () => projects,
    find_by_id: async (id) => projects.find((candidate) => candidate.id === id) ?? null,
  };
  const definitionRepository: WorkflowDefinitionRepository = {
    insert_immutable: async (value) => { definitions.push(value); return value; },
    find_by_id: async (id) => definitions.find((candidate) => candidate.id === id) ?? null,
    find_by_name_version: async (name, version) => definitions.find((candidate) => candidate.name === name && candidate.version === version) ?? null,
    list: async (includeArchived = false) => definitions.filter((candidate) => includeArchived || !candidate.archived),
    set_archived: async (id, archived) => { const index = definitions.findIndex((candidate) => candidate.id === id); if (index < 0) return null; definitions[index] = { ...definitions[index]!, archived }; return definitions[index]!; },
  };
  const app = createConfigurationApp({ projects: projectRepository, definitions: definitionRepository, project_identity: { resolve: async () => identity ? { forge_repository: identity, base_branch: baseBranch } : null }, now: () => "2026-08-15T12:00:00Z", new_id: () => generatedId });
  return { app, projects, definitions };
};

test("project creation and listing preserve the existing public response", async () => {
  const subject = fixture();
  const created = await subject.app.request("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Oakridge", repo_dir: "/code/oakridge" }) });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual(project);
  const listed = await subject.app.request("/projects");
  expect(await listed.json()).toEqual([project]);
});

test("unexpected project storage failures are server errors", async () => {
  const response = await fixture(project.id, null, null, true).app.request("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Oakridge", repo_dir: "/code/oakridge" }) });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "storage unavailable" });
});

test("project creation persists resolved forge identity and base branch", async () => {
  const identity = { provider: "github" as const, owner: "RankOneLabs", name: "oakridge" };
  const subject = fixture(project.id, identity, "main");
  const response = await subject.app.request("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Oakridge", repo_dir: "/code/oakridge" }) });
  expect(await response.json()).toEqual(expect.objectContaining({ forge_repository: identity, base_branch: "main" }));
  expect(subject.projects[0]).toEqual(expect.objectContaining({ forge_repository: identity, base_branch: "main" }));
});

test("workflow definition creation owns identifiers and normalizes the legacy delivery name", async () => {
  const subject = fixture(definition.id);
  const response = await subject.app.request("/workflow_defs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "flow", version: 1, graph: { stages: { review: { stage_type: "stub", config: {}, inputs: [{ name: "input", artifact_type: "dev.input", delivery: "stage_complete" }], outputs: [] } }, edges: [] } }) });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(expect.objectContaining({ id: definition.id, name: "flow", version: 1, archived: false, graph: { stages: { review: expect.objectContaining({ inputs: [expect.objectContaining({ delivery: "producer_complete" })] }) }, edges: [] } }));
});

test("definition listing hides archived definitions unless explicitly requested", async () => {
  const subject = fixture(); subject.definitions.push(definition, { ...definition, id: "00000000-0000-4000-8000-000000000003" as WorkflowDefinitionId, version: 2, archived: true });
  const active = await subject.app.request("/workflow_defs");
  expect((await active.json()) as unknown[]).toHaveLength(1);
  const all = await subject.app.request("/workflow_defs?include_archived=1");
  expect((await all.json()) as unknown[]).toHaveLength(2);
});

test("definition archive and unarchive are idempotent public commands", async () => {
  const subject = fixture(); subject.definitions.push(definition);
  expect((await subject.app.request(`/workflow_defs/${definition.id}/archive`, { method: "POST" })).status).toBe(204);
  expect(subject.definitions[0]?.archived).toBe(true);
  expect((await subject.app.request(`/workflow_defs/${definition.id}/unarchive`, { method: "POST" })).status).toBe(204);
  expect(subject.definitions[0]?.archived).toBe(false);
});
