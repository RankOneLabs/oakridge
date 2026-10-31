import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CoreClient } from "../core-client/client";
import { compileWorkflow } from "../core-client/client";
import type { Workflow } from "../core-client/core-types";
import type { RunId } from "../domain/primitives";
import type { OperationRunner } from "../operations/runner";
import { selectDefinitionSummary } from "../projections/definition-view";
import { redactingReadResponses } from "../projections/serialization-view";
import { readWorkflowPrompts } from "../runtime/prompt-files";
import type { Database } from "../storage/database";
import { pinDefinition, setDefinitionArchived, setRunArchived } from "../storage/registry-store";
import { deleteRun } from "../storage/run-deletion";
import { listPromptCatalog } from "../../../workflow-config/src/prompt-catalog";
import { browserWriteMiddleware, type BrowserWritePolicy } from "./browser-write-policy";
import { collaborationHandlers } from "./collaboration";
import { classifiedRoutesMiddleware, controlTokenMiddleware, loopbackHostMiddleware, operatorCredentialCheck, type ServedControlPlaneAccess } from "./control-auth";
import { errorResponse, fault, InvalidPayloadError, MalformedRequestError, MissingEntityError, requestBody } from "./errors";
import { installEventStream } from "./events";
import { installIngress } from "./ingress";
import { installMergeStatus } from "./merge-status";
import { installProjectApi } from "./projects";
import { installReadModels } from "./read-models";

export interface DefinitionApiDependencies {
  readonly db: Database;
  readonly core: CoreClient;
  readonly wake: (run_id: RunId) => void;
  /** Whether a request on the publish route is the operator's edit rather than a session's publication. */
  readonly is_operator_request: (request: Request) => boolean;
}
export interface HttpAppDependencies extends Omit<DefinitionApiDependencies, "is_operator_request"> {
  readonly application_version: string;
  /** A token every operator route demands, or none: a loopback bind (open to loopback-addressed requests only) or an explicitly insecure one. */
  readonly access: ServedControlPlaneAccess;
  readonly write_policy: BrowserWritePolicy;
  readonly operations?: OperationRunner | null;
}
export const httpBodyLimit = () => bodyLimit({ maxSize: 1_048_576,
  onError: (context) => context.json({ kind: "oversized_payload", limit: 1_048_576 }, 413) });

const isObject = (value: unknown): value is { readonly [key: string]: unknown } => !!value && typeof value === "object" && !Array.isArray(value);

const isPromptPath = (value: unknown): boolean => typeof value === "string";
const isOptionalPromptPath = (value: unknown): boolean => value === undefined || value === null || isPromptPath(value);
/** The workflow's outline, enough to read its prompts; the core checks the rest when it compiles. */
export function isWorkflowOutline(value: unknown): value is Workflow {
  return isObject(value) && typeof value.workflow === "string" && isObject(value.run) && isObject(value.stages)
    && Object.values(value.stages).every((stage) => isObject(stage) && isObject(stage.workers)
      && Object.values(stage.workers).every((worker) => isObject(worker)
        && (worker.kind !== "agent" || isObject(worker.prompts) && Object.values(worker.prompts).every(isOptionalPromptPath)))
      && (stage.reviews === undefined || isObject(stage.reviews)
        && Object.values(stage.reviews).every((review) => isObject(review) && isOptionalPromptPath(review.prompt))));
}

/**
 * The whole HTTP surface: every route in `HTTP_ROUTES`, behind the middleware
 * that refuses a route the table does not classify and, with a token
 * configured, an operator route without it. With none on a loopback bind, a
 * request addressed to any but a loopback name is refused.
 */
export function createHttpApp(deps: HttpAppDependencies): Hono {
  const control_token = deps.access.kind === "token_required" ? deps.access.token : null;
  const app = new Hono();
  if (deps.access.kind === "loopback_open") app.use("*", loopbackHostMiddleware());
  app.use("*", httpBodyLimit());
  app.use("*", classifiedRoutesMiddleware());
  app.use("*", redactingReadResponses());
  app.use("*", browserWriteMiddleware(deps.write_policy));
  if (control_token !== null) app.use("*", controlTokenMiddleware(control_token, deps.write_policy));
  installDefinitionApi(app, { ...deps, is_operator_request: operatorCredentialCheck(control_token, deps.write_policy) });
  installMergeStatus(app, { db: deps.db, operations: deps.operations ?? null });
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
  installReadModels(app, deps);
  const collaboration = collaborationHandlers({ db: deps.db });
  app.get("/api/runs/:run_id/units/:unit_id/revisions/:revision_id/threads", collaboration.getThreads);
  app.post("/api/runs/:run_id/units/:unit_id/revisions/:revision_id/threads", collaboration.createThread);
  app.post("/api/runs/:run_id/units/:unit_id/threads/:thread_id/messages", collaboration.addMessage);
  app.post("/api/runs/:run_id/units/:unit_id/threads/:thread_id/review-items", collaboration.addReviewItem);

  app.get("/api/prompts", () => { try { return Response.json(listPromptCatalog()); }
    catch (cause) { return fault(cause); } });
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
      return Response.json(selectDefinitionSummary({ bundle_id: pinned.bundle.id, digest: pinned.bundle.digest,
        source: pinned.bundle.source, checked_program: pinned.bundle.checked_program, archived_at: pinned.bundle.archived_at }),
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
}
