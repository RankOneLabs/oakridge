import type { Hono } from "hono";
import { err, ok, type Result } from "../domain/primitives";
import type { ProjectDraft, ProjectWriteError } from "../domain/projects";
import { listProjects } from "../storage/projection-reader";
import type { MutationService } from "../storage/mutation-service";
import type { ProjectId, ProjectRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { commandStatus, ConflictError, InternalFaultError, InvalidPayloadError, MalformedRequestError, MissingEntityError, type CommandError } from "./scope-commands";

export type { ProjectDraft } from "../domain/projects";
/** A saved project as the operator API returns it. */
export type ProjectView = ProjectRecord;
export interface ProjectList { readonly items: readonly ProjectView[] }

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isObject = (value: unknown): value is { readonly [key: string]: unknown } => !!value && typeof value === "object" && !Array.isArray(value);

/** The operator's draft, checked at the HTTP boundary. */
export function parseProjectDraft(value: unknown): Result<ProjectDraft, InvalidPayloadError> {
  if (!isObject(value)) return err(new InvalidPayloadError("project must be an object"));
  const { name, repo_dir, forge_repository, integration_branch } = value;
  if (!text(name)) return err(new InvalidPayloadError("name is required"));
  if (!text(repo_dir) || !repo_dir.startsWith("/")) return err(new InvalidPayloadError("repo_dir must be an absolute path"));
  if (integration_branch !== null && integration_branch !== undefined && !text(integration_branch))
    return err(new InvalidPayloadError("integration_branch must be a branch name or null"));
  if (forge_repository === null || forge_repository === undefined)
    return ok({ name: name.trim(), repo_dir, forge_repository: null, integration_branch: integration_branch ?? null });
  if (!isObject(forge_repository) || forge_repository.provider !== "github" || !text(forge_repository.owner) || !text(forge_repository.name))
    return err(new InvalidPayloadError("forge_repository must name a github owner and repository"));
  return ok({ name: name.trim(), repo_dir, integration_branch: integration_branch ?? null,
    forge_repository: { provider: "github", owner: forge_repository.owner, name: forge_repository.name } });
}

function failure(error: CommandError): Response {
  const body = error instanceof InternalFaultError ? { error: error.kind, detail: "internal fault", trace_id: error.trace_id } : { error: error.kind, detail: error.detail };
  return Response.json(body, { status: commandStatus({ ok: false, error }) });
}
function writeFailure(error: ProjectWriteError): Response {
  return failure(error.kind === "missing" ? new MissingEntityError("project not found") : new ConflictError(`a project named ${error.name} exists`));
}
async function draftOf(request: Request): Promise<Result<ProjectDraft, CommandError>> {
  try { return parseProjectDraft(await request.json()); } catch { return err(new MalformedRequestError("invalid JSON")); }
}

export function installProjectApi(app: Hono, deps: { readonly db: TransactionalSqlExecutor; readonly mutations: MutationService }): void {
  app.get("/api/projects", async () => {
    try { return Response.json({ items: await listProjects(deps.db) } satisfies ProjectList); }
    catch (cause) { return failure(new InternalFaultError(String(cause))); }
  });
  app.post("/api/projects", async (c) => {
    const draft = await draftOf(c.req.raw);
    if (!draft.ok) return failure(draft.error);
    try {
      const created = await deps.mutations.createProject(crypto.randomUUID() as ProjectId, draft.value);
      return created.ok ? Response.json(created.value, { status: 201 }) : writeFailure(created.error);
    } catch (cause) { return failure(new InternalFaultError(String(cause))); }
  });
  app.put("/api/projects/:project_id", async (c) => {
    const draft = await draftOf(c.req.raw);
    if (!draft.ok) return failure(draft.error);
    try {
      const updated = await deps.mutations.updateProject(c.req.param("project_id") as ProjectId, draft.value);
      return updated.ok ? Response.json(updated.value) : writeFailure(updated.error);
    } catch (cause) { return failure(new InternalFaultError(String(cause))); }
  });
}
