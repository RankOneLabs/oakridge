import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { z } from "zod";

import { parseUuidId, type JsonValue, type ProjectId, type WorkflowDefinitionId } from "../domain/primitives";
import type { CreateWorkflowDefinition, WorkflowGraph } from "../domain/workflow";
import type { ProjectRepository, WorkflowDefinitionRepository } from "../storage/repositories";
import type { ProjectRepositoryIdentityResolver } from "../domain/projects";
import { parseWorkflowDefinition } from "../validation/workflow-definition";

export interface ConfigurationHttpDependencies {
  readonly projects: ProjectRepository;
  readonly definitions: WorkflowDefinitionRepository;
  readonly project_identity: ProjectRepositoryIdentityResolver;
  readonly now: () => string;
  readonly new_id?: () => string;
}

const createProjectSchema = z.object({ name: z.string().trim().min(1), repo_dir: z.string().trim().min(1) });
const createDefinitionSchema = z.object({ name: z.string().trim().min(1), version: z.number().int().positive(), graph: z.json() });
type JsonObject = { readonly [key: string]: JsonValue };
const isJsonObject = (value: JsonValue): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const normalizePublicGraph = (graph: JsonValue): JsonValue => {
  if (!isJsonObject(graph)) return graph;
  const stages = graph.stages;
  if (!isJsonObject(stages)) return graph;
  const normalizedStages = Object.fromEntries(Object.entries(stages).map(([stageKey, stage]) => {
    if (!isJsonObject(stage) || !Array.isArray(stage.inputs)) return [stageKey, stage];
    const inputs = stage.inputs.map((input) => {
      if (!isJsonObject(input) || input.delivery !== "stage_complete") return input;
      return { ...input, delivery: "producer_complete" };
    });
    return [stageKey, { ...stage, inputs }];
  }));
  return { ...graph, stages: normalizedStages } as JsonValue;
};

export const createConfigurationApp = (dependencies: ConfigurationHttpDependencies): Hono => {
  const app = new Hono();
  const newId = dependencies.new_id ?? randomUUID;

  app.get("/projects", async (http) => http.json(await dependencies.projects.list()));
  app.post("/projects", async (http) => {
    const parsed = createProjectSchema.safeParse(await http.req.json().catch(() => null));
    if (!parsed.success) return http.json({ error: "name and repo_dir are required" }, 400);
    try {
      const identity = await dependencies.project_identity.resolve(parsed.data.repo_dir);
      const project = await dependencies.projects.insert({ id: newId() as ProjectId, ...parsed.data, created_at: dependencies.now(), forge_repository: identity?.forge_repository ?? null, base_branch: identity?.base_branch ?? null });
      return http.json(project, 201);
    } catch (error) {
      return http.json({ error: error instanceof Error ? error.message : "project creation failed" }, 500);
    }
  });

  app.get("/workflow_defs", async (http) => {
    const includeArchived = http.req.query("include_archived") === "1" || http.req.query("include_archived") === "true";
    return http.json(await dependencies.definitions.list(includeArchived));
  });
  app.get("/workflow_defs/:id", async (http) => {
    const definitionId = parseUuidId<WorkflowDefinitionId>(http.req.param("id"));
    const definition = definitionId && await dependencies.definitions.find_by_id(definitionId);
    return definition ? http.json(definition) : http.json({ error: "workflow definition not found" }, 404);
  });
  app.post("/workflow_defs", async (http) => {
    const parsed = createDefinitionSchema.safeParse(await http.req.json().catch(() => null));
    if (!parsed.success) return http.json({ error: "invalid workflow definition" }, 400);
    const request: CreateWorkflowDefinition = { ...parsed.data, graph: normalizePublicGraph(parsed.data.graph) as unknown as WorkflowGraph };
    const definition = parseWorkflowDefinition({ ...request, id: newId(), created_at: dependencies.now(), archived: false });
    if (!definition.ok) return http.json({ error: definition.error.detail }, 400);
    try {
      return http.json(await dependencies.definitions.insert_immutable(definition.value), 201);
    } catch (error) {
      return http.json({ error: error instanceof Error ? error.message : "workflow definition conflicts with stored content" }, 409);
    }
  });
  app.post("/workflow_defs/:id/archive", async (http) => {
    const definitionId = parseUuidId<WorkflowDefinitionId>(http.req.param("id"));
    const definition = definitionId && await dependencies.definitions.set_archived(definitionId, true);
    return definition ? http.body(null, 204) : http.json({ error: "workflow definition not found" }, 404);
  });
  app.post("/workflow_defs/:id/unarchive", async (http) => {
    const definitionId = parseUuidId<WorkflowDefinitionId>(http.req.param("id"));
    const definition = definitionId && await dependencies.definitions.set_archived(definitionId, false);
    return definition ? http.body(null, 204) : http.json({ error: "workflow definition not found" }, 404);
  });
  return app;
};
