import { Hono } from "hono";
import { errorResponse } from "./errors";
import { credentialFor } from "./ingest-auth";
import { registerSourceRoutes } from "./sources";
import { registerItemRoutes } from "./items";
import { registerEvaluationRoutes } from "./evaluations";
import { registerGradeRoutes } from "./grades";
import { registerExportRoutes } from "./exports";
import { registerLangfuseRoutes, type LangfuseRouteDependencies } from "./langfuse-sync";

export function createApp(deps: LangfuseRouteDependencies): Hono {
  const app = new Hono();
  registerSourceRoutes(app, deps);
  registerItemRoutes(app, deps);
  registerEvaluationRoutes(app, deps);
  registerGradeRoutes(app, deps);
  registerExportRoutes(app, deps);
  if (deps.langfuse?.status === "enabled") registerLangfuseRoutes(app, deps);
  app.notFound((c) => credentialFor(c.req.header("authorization"), deps.credentials.ingest)
    ? errorResponse(c, 403, "forbidden", "ingest credential cannot use this route")
    : errorResponse(c, 404, "not_found", "route not found"));
  app.onError((error, c) => {
    console.error("[observation] internal error", { method: c.req.method, path: c.req.path, error });
    return errorResponse(c, 500, "internal_error", "internal service error");
  });
  return app;
}
