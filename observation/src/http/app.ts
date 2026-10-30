import { Hono } from "hono";
import { errorResponse } from "./errors";
import { credentialFor } from "./ingest-auth";
import { registerSourceRoutes } from "./sources";
import { registerItemRoutes } from "./items";
import { registerEvaluationRoutes } from "./evaluations";
import { registerGradeRoutes } from "./grades";
import { registerExportRoutes } from "./exports";
import { registerLangfuseRoutes } from "./langfuse-sync";
import type { LangfuseConfiguration } from "../langfuse/config";
import type { SourceDependencies } from "./sources";

export function createApp(deps: SourceDependencies & { readonly langfuse?: LangfuseConfiguration }): Hono {
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
  app.onError((_error, c) => errorResponse(c, 500, "internal_error", "internal service error"));
  return app;
}
