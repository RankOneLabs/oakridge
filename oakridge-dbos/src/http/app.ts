import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CoreClient } from "../core-client/client";
import type { RunId } from "../domain/primitives";
import type { OperationRunner } from "../operations/runner";
import { redactingReadResponses } from "../projections/serialization-view";
import type { Database } from "../storage/database";
import { setRunArchived } from "../storage/operator-store";
import { deleteRun } from "../storage/run-deletion";
import { listCommittedPrompts } from "../runtime/definition-store";
import { browserWriteMiddleware, type BrowserWritePolicy } from "./browser-write-policy";
import { collaborationHandlers } from "./collaboration";
import { classifiedRoutesMiddleware, controlTokenMiddleware, loopbackHostMiddleware, operatorCredentialCheck, type ServedControlPlaneAccess } from "./control-auth";
import { errorResponse, fault, MissingEntityError } from "./errors";
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

  app.get("/api/prompts", () => { try { return Response.json(listCommittedPrompts()); }
    catch (cause) { return fault(cause); } });
  const archiveRun = (is_archived: boolean) => async (c: Context<{}, "/api/runs/:run_id/:action">) => { try {
    return await setRunArchived(deps.db, c.req.param("run_id") as RunId, is_archived)
      ? c.json({ run_id: c.req.param("run_id"), is_archived }) : errorResponse(new MissingEntityError("run not found"));
  } catch (cause) { return fault(cause); } };
  app.post("/api/runs/:run_id/archive", archiveRun(true));
  app.post("/api/runs/:run_id/unarchive", archiveRun(false));
}
