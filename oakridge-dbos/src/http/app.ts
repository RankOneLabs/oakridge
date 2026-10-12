import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CoreClient } from "../core-client/client";
import { compileWorkflow } from "../core-client/client";
import type { Event, Workflow } from "../core-client/core-types";
import type { ProjectId, RunId } from "../domain/primitives";
import { readWorkflowPrompts } from "../runtime/prompt-files";
import { commitEvent, launchRunId, type CommitOutcome, type CommitResult } from "../storage/commit";
import type { Database } from "../storage/database";
import { listDefinitions, listRuns, readDefinition, readPinnedDefinition, readRunInspect, readRunView } from "../storage/read-store";
import { findLaunchableDefinition, hasProject, pinDefinition, setDefinitionArchived, setRunArchived } from "../storage/registry-store";
import { listPromptCatalog } from "../../../workflow-config/src/prompt-catalog";
import { collaborationHandlers } from "./collaboration";
import { operatorWriterFromCredential } from "./control-auth";
import { errorResponse, fault, InvalidPayloadError, MalformedRequestError, MissingEntityError, requestBody } from "./errors";
import { installProjectApi } from "./projects";

export interface DefinitionApiDependencies { readonly db: Database; readonly core: CoreClient; readonly wake: (run_id: RunId) => void }
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
const requestId = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 200;

/** The workflow's outline, enough to find its prompts; the core checks the rest when it compiles. */
function isWorkflowOutline(value: unknown): value is Workflow {
  return isObject(value) && typeof value.workflow === "string" && isObject(value.run) && isObject(value.stages)
    && Object.values(value.stages).every((stage) => isObject(stage) && isObject(stage.workers)
      && Object.values(stage.workers).every((worker) => isObject(worker) && (worker.kind !== "agent" || isObject(worker.prompts)))
      && (stage.reviews === undefined || isObject(stage.reviews) && Object.values(stage.reviews).every(isObject)));
}

/** One commit outcome as an HTTP response: a step rejection is 409, as is a reused ingress id. */
function ingressResponse(run_id: string, result: CommitResult): Response {
  if (!result.ok) return fault(`${result.error.operation} ${result.error.entity_id}: ${result.error.detail}`);
  const outcome: CommitOutcome = result.value;
  switch (outcome.kind) {
    case "committed": return Response.json({ run_id, event_id: outcome.event_id }, { status: 201 });
    case "replayed": return outcome.receipt.kind === "committed" ? Response.json({ run_id, event_id: outcome.receipt.event_id })
      : Response.json({ kind: "rejected", reason: outcome.receipt.reason }, { status: 409 });
    case "rejected": return Response.json({ kind: "rejected", reason: outcome.reason }, { status: 409 });
    case "conflict": return Response.json({ kind: "conflict", detail: outcome.detail }, { status: 409 });
    case "missing": return errorResponse(new MissingEntityError(outcome.detail));
  }
}

export function installDefinitionApi(app: Hono, deps: DefinitionApiDependencies): void {
  const commit = { db: deps.db, core: deps.core, wake: deps.wake };
  installProjectApi(app, deps);
  const collaboration = collaborationHandlers({ db: deps.db });
  app.get("/api/runs/:run_id/scopes/:scope_id/revisions/:revision_id/threads", collaboration.getThreads);
  app.post("/api/runs/:run_id/scopes/:scope_id/revisions/:revision_id/threads", collaboration.createThread);
  app.post("/api/runs/:run_id/scopes/:scope_id/threads/:thread_id/messages", collaboration.addMessage);
  app.post("/api/runs/:run_id/scopes/:scope_id/threads/:thread_id/review-items", collaboration.addReviewItem);

  app.get("/api/runs", async (c) => { try {
    const limit = pageLimit(c.req.query("limit"));
    if (limit instanceof MalformedRequestError) return errorResponse(limit);
    const after = runCursor(c.req.query("cursor"));
    if (after instanceof MalformedRequestError) return errorResponse(after);
    const is_archived = archivedQuery(c.req.query("archived"));
    if (is_archived instanceof MalformedRequestError) return errorResponse(is_archived);
    return Response.json(await listRuns(deps.db, { after, limit, is_archived }));
  } catch (cause) { return fault(cause); } });

  app.post("/api/runs", async (c) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    if (!isObject(raw) || !requestId(raw.request_id) || typeof raw.digest !== "string" || !("input" in raw)
      || !(raw.project_id === undefined || raw.project_id === null || typeof raw.project_id === "string"))
      return errorResponse(new MalformedRequestError("request_id (1 to 200 characters), digest and input are required"));
    try {
      const definition_bundle_id = await findLaunchableDefinition(deps.db, raw.digest);
      if (!definition_bundle_id) return errorResponse(new MissingEntityError("definition not found"));
      const project_id = typeof raw.project_id === "string" ? raw.project_id as ProjectId : null;
      if (project_id && !await hasProject(deps.db, project_id)) return errorResponse(new MissingEntityError("project not found"));
      const run_id = launchRunId(raw.request_id);
      return ingressResponse(run_id, await commitEvent(commit, { run_id, ingress_id: raw.request_id,
        event: { kind: "launched", input: raw.input }, writer: operatorWriterFromCredential(c.req.raw),
        launch: { definition_bundle_id, project_id } }));
    } catch (cause) { return fault(cause); }
  });

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

  /** An operator event on a run: the body carries only its request id; the writer is the credential. */
  const operatorEvent = (event: (c: Context) => Event) => async (c: Context) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    if (!isObject(raw) || !requestId(raw.request_id)) return errorResponse(new MalformedRequestError("request_id is required"));
    const run_id = c.req.param("run_id") as RunId;
    try {
      return ingressResponse(run_id, await commitEvent(commit, { run_id, ingress_id: raw.request_id, event: event(c),
        writer: operatorWriterFromCredential(c.req.raw) }));
    } catch (cause) { return fault(cause); }
  };
  app.post("/api/runs/:run_id/cancel", operatorEvent(() => ({ kind: "cancel_requested" })));
  app.post("/api/runs/:run_id/units/:unit_id/workers/:worker/retry", operatorEvent((c) =>
    ({ kind: "retry_requested", unit: c.req.param("unit_id") ?? "", worker: c.req.param("worker") ?? "" })));

  app.get("/api/runs/:run_id/inspect", async (c) => { try {
    const inspect = await readRunInspect(deps.db, c.req.param("run_id"));
    return inspect ? c.json(inspect) : errorResponse(new MissingEntityError("run not found"));
  } catch (cause) { return fault(cause); } });
  app.get("/api/runs/:run_id/definition", async (c) => { try {
    const pinned = await readPinnedDefinition(deps.db, c.req.param("run_id"));
    return pinned ? c.json(pinned) : errorResponse(new MissingEntityError("run not found"));
  } catch (cause) { return fault(cause); } });
}
