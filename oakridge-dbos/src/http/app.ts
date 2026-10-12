import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CoreClient } from "../core-client/client";
import { compileWorkflow } from "../core-client/client";
import type { Workflow } from "../core-client/core-types";
import type { RunId } from "../domain/primitives";
import { redactingReadResponses } from "../projections/serialization-view";
import { readWorkflowPrompts } from "../runtime/prompt-files";
import type { Database } from "../storage/database";
import { listDefinitions, listRuns, readDefinition, readPinnedDefinition, readRunInspect, readRunView } from "../storage/read-store";
import { pinDefinition, setDefinitionArchived, setRunArchived } from "../storage/registry-store";
import { deleteRun } from "../storage/run-deletion";
import { listPromptCatalog } from "../../../workflow-config/src/prompt-catalog";
import { browserWriteMiddleware, type BrowserWritePolicy } from "./browser-write-policy";
import { collaborationHandlers } from "./collaboration";
import { classifiedRoutesMiddleware, controlTokenMiddleware } from "./control-auth";
import { errorResponse, fault, InvalidPayloadError, MalformedRequestError, MissingEntityError, requestBody } from "./errors";
import { installEventStream } from "./events";
import { installIngress } from "./ingress";
import { installProjectApi } from "./projects";

export interface DefinitionApiDependencies { readonly db: Database; readonly core: CoreClient; readonly wake: (run_id: RunId) => void }
export interface HttpAppDependencies extends DefinitionApiDependencies {
  readonly application_version: string;
  /** Null when the bind is loopback (or explicitly insecure) and no token is configured. */
  readonly control_token: string | null;
  readonly write_policy: BrowserWritePolicy;
}
export const httpBodyLimit = () => bodyLimit({ maxSize: 1_048_576,
  onError: (context) => context.json({ kind: "oversized_payload", limit: 1_048_576 }, 413) });

const DEFAULT_PAGE_LIMIT = 100;
function pageLimit(raw: string | undefined): number | MalformedRequestError {
  const limit = raw === undefined ? DEFAULT_PAGE_LIMIT : Number(raw);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= DEFAULT_PAGE_LIMIT ? limit : new MalformedRequestError("invalid page limit");
}
interface RunPageCursor { readonly created_at: string; readonly id: string }
function runCursor(raw: string | undefined): RunPageCursor | null | MalformedRequestError {
  if (raw === undefined) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || !("created_at" in value) || typeof value.created_at !== "string"
      || !Number.isFinite(Date.parse(value.created_at)) || !("id" in value) || typeof value.id !== "string" || !value.id)
      throw new Error("bad cursor");
    return { created_at: value.created_at, id: value.id };
  } catch { return new MalformedRequestError("invalid runs cursor"); }
}
function definitionCursor(raw: string | undefined): string | null | MalformedRequestError {
  if (raw === undefined) return null;
  const value = Buffer.from(raw, "base64url").toString("utf8");
  return /^[0-9a-f-]{36}$/i.test(value) ? value : new MalformedRequestError("invalid definitions cursor");
}
/** `?archived=true` lists archived items; without it, the active ones. */
function archivedQuery(raw: string | undefined): boolean | MalformedRequestError {
  if (raw === undefined || raw === "false") return false;
  return raw === "true" ? true : new MalformedRequestError("archived must be true or false");
}
const isObject = (value: unknown): value is { readonly [key: string]: unknown } => !!value && typeof value === "object" && !Array.isArray(value);

const isPromptPath = (value: unknown): boolean => typeof value === "string";
const isOptionalPromptPath = (value: unknown): boolean => value === undefined || value === null || isPromptPath(value);
/** The workflow's outline, enough to read its prompts; the core checks the rest when it compiles. */
function isWorkflowOutline(value: unknown): value is Workflow {
  return isObject(value) && typeof value.workflow === "string" && isObject(value.run) && isObject(value.stages)
    && Object.values(value.stages).every((stage) => isObject(stage) && isObject(stage.workers)
      && Object.values(stage.workers).every((worker) => isObject(worker)
        && (worker.kind !== "agent" || isObject(worker.prompts) && Object.values(worker.prompts).every(isPromptPath)))
      && (stage.reviews === undefined || isObject(stage.reviews)
        && Object.values(stage.reviews).every((review) => isObject(review) && isOptionalPromptPath(review.prompt))));
}

/**
 * The whole HTTP surface: every route in `HTTP_ROUTES`, behind the middleware
 * that refuses a route the table does not classify and, with a token
 * configured, an operator route without it.
 */
export function createHttpApp(deps: HttpAppDependencies): Hono {
  const app = new Hono();
  app.use("*", httpBodyLimit());
  app.use("*", classifiedRoutesMiddleware());
  app.use("*", redactingReadResponses());
  app.use("*", browserWriteMiddleware(deps.write_policy));
  if (deps.control_token !== null) app.use("*", controlTokenMiddleware(deps.control_token, deps.write_policy));
  installDefinitionApi(app, deps);
  installEventStream(app, { db: deps.db });
  app.get("/health", (context) => context.json({ status: "ok", application_version: deps.application_version, core: deps.core.health }));
  app.delete("/runs/:run_id", async (context) => {
    try {
      const result = await deleteRun(deps.db, context.req.param("run_id") as RunId);
      if (result.kind === "missing") return errorResponse(new MissingEntityError("run not found"));
      return context.json(result, result.kind === "refused" ? 409 : 200);
    } catch (cause) { return fault(cause); }
  });
  return app;
}

export function installDefinitionApi(app: Hono, deps: DefinitionApiDependencies): void {
  installProjectApi(app, deps);
  installIngress(app, deps);
  const collaboration = collaborationHandlers({ db: deps.db });
  app.get("/api/runs/:run_id/units/:unit_id/revisions/:revision_id/threads", collaboration.getThreads);
  app.post("/api/runs/:run_id/units/:unit_id/revisions/:revision_id/threads", collaboration.createThread);
  app.post("/api/runs/:run_id/units/:unit_id/threads/:thread_id/messages", collaboration.addMessage);
  app.post("/api/runs/:run_id/units/:unit_id/threads/:thread_id/review-items", collaboration.addReviewItem);

  app.get("/api/runs", async (c) => { try {
    const limit = pageLimit(c.req.query("limit"));
    if (limit instanceof MalformedRequestError) return errorResponse(limit);
    const after = runCursor(c.req.query("cursor"));
    if (after instanceof MalformedRequestError) return errorResponse(after);
    const is_archived = archivedQuery(c.req.query("archived"));
    if (is_archived instanceof MalformedRequestError) return errorResponse(is_archived);
    return Response.json(await listRuns(deps.db, { after, limit, is_archived }));
  } catch (cause) { return fault(cause); } });

  app.get("/api/definitions", async (c) => { try {
    const limit = pageLimit(c.req.query("limit"));
    if (limit instanceof MalformedRequestError) return errorResponse(limit);
    const after = definitionCursor(c.req.query("cursor"));
    if (after instanceof MalformedRequestError) return errorResponse(after);
    const is_archived = archivedQuery(c.req.query("archived"));
    if (is_archived instanceof MalformedRequestError) return errorResponse(is_archived);
    return Response.json(await listDefinitions(deps.db, { after, limit, is_archived }));
  } catch (cause) { return fault(cause); } });
  app.get("/api/prompts", () => { try { return Response.json(listPromptCatalog()); }
    catch (cause) { return fault(cause); } });
  app.get("/api/definitions/:bundle_id", async (c) => { try {
    const definition = await readDefinition(deps.db, c.req.param("bundle_id"));
    return definition ? c.json(definition) : errorResponse(new MissingEntityError("definition not found"));
  } catch (cause) { return fault(cause); } });

  /** Compile a workflow against its prompt files; `pin` stores it. */
  const compile = (is_pinned: boolean) => async (c: Context) => {
    const source = await requestBody(c.req.raw);
    if (source instanceof MalformedRequestError) return errorResponse(source);
    if (!isWorkflowOutline(source)) return errorResponse(new InvalidPayloadError("body must be a workflow"));
    try {
      const prompts = readWorkflowPrompts(source);
      if (!prompts.ok) return errorResponse(new InvalidPayloadError(`${prompts.error.entity_id}: ${prompts.error.detail}`));
      const texts = Object.fromEntries(Object.entries(prompts.value).map(([path, prompt]) => [path, prompt.content]));
      const compiled = await compileWorkflow(deps.core, { workflow: source, prompts: texts });
      if (!compiled.ok) return errorResponse(new InvalidPayloadError(compiled.error.detail));
      if (!is_pinned) return Response.json(compiled.value);
      const pinned = await pinDefinition(deps.db, { source, compiled: compiled.value, prompts: prompts.value });
      return Response.json({ bundle_id: pinned.bundle.id, digest: pinned.bundle.digest, source: pinned.bundle.source, archived_at: pinned.bundle.archived_at },
        { status: pinned.kind === "pinned" ? 201 : 200 });
    } catch (cause) { return fault(cause); }
  };
  app.post("/api/definitions/compile", compile(false));
  app.post("/api/definitions", compile(true));

  const archiveRun = (is_archived: boolean) => async (c: Context<{}, "/api/runs/:run_id/:action">) => { try {
    return await setRunArchived(deps.db, c.req.param("run_id") as RunId, is_archived)
      ? c.json({ run_id: c.req.param("run_id"), is_archived }) : errorResponse(new MissingEntityError("run not found"));
  } catch (cause) { return fault(cause); } };
  const archiveDefinition = (is_archived: boolean) => async (c: Context<{}, "/api/definitions/:bundle_id/:action">) => { try {
    return await setDefinitionArchived(deps.db, c.req.param("bundle_id"), is_archived)
      ? c.json({ bundle_id: c.req.param("bundle_id"), is_archived }) : errorResponse(new MissingEntityError("definition not found"));
  } catch (cause) { return fault(cause); } };
  app.post("/api/runs/:run_id/archive", archiveRun(true));
  app.post("/api/runs/:run_id/unarchive", archiveRun(false));
  app.post("/api/definitions/:bundle_id/archive", archiveDefinition(true));
  app.post("/api/definitions/:bundle_id/unarchive", archiveDefinition(false));

  app.get("/api/runs/:run_id", async (c) => { try {
    const view = await readRunView(deps.db, c.req.param("run_id"));
    return view ? c.json(view) : errorResponse(new MissingEntityError("run not found"));
  } catch (cause) { return fault(cause); } });

  app.get("/api/runs/:run_id/inspect", async (c) => { try {
    const inspect = await readRunInspect(deps.db, c.req.param("run_id"));
    return inspect ? c.json(inspect) : errorResponse(new MissingEntityError("run not found"));
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/definition", async (c) => { try {
    const pinned = await readPinnedDefinition(deps.db, c.req.param("run_id"));
    return pinned ? c.json(pinned) : errorResponse(new MissingEntityError("run not found"));
  } catch (cause) { return fault(cause); } });
}
