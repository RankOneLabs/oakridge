import { Hono } from "hono";
import { errorResponse } from "./errors";
import { credentialFor } from "./ingest-auth";
import { registerSourceRoutes } from "./sources";
import { registerItemRoutes } from "./items";
import { registerEvaluationRoutes } from "./evaluations";
import { registerGradeRoutes } from "./grades";
import { registerGradingRecordRoutes } from "./grading-records";
import { registerHealthRoute, type HealthDependencies } from "./health";
import type { SourceDependencies } from "./sources";

export function createApp(deps: SourceDependencies & HealthDependencies): Hono {
  const app = new Hono();
  registerHealthRoute(app, deps);
  registerSourceRoutes(app, deps);
  registerItemRoutes(app, deps);
  registerEvaluationRoutes(app, deps);
  registerGradeRoutes(app, deps);
  registerGradingRecordRoutes(app, deps);
  app.notFound((c) => credentialFor(c.req.header("authorization"), deps.credentials.ingest)
    ? errorResponse(c, 403, "forbidden", "ingest credential cannot use this route")
    : errorResponse(c, 404, "not_found", "route not found"));
  app.onError((error, c) => {
    console.error("[observation] internal error", { method: c.req.method, path: c.req.path, error });
    return errorResponse(c, 500, "internal_error", "internal service error");
  });
  return app;
}
