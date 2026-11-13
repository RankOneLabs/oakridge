import type { RuntimeConfiguration } from "../grading/runtime-configuration";
import { registerGradingConfigRoutes, type GradingConfigDependencies } from "./grading-config";
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

export type AppDependencies = { readonly grading_config?: GradingConfigDependencies } & ((SourceDependencies & HealthDependencies)
  | (Omit<SourceDependencies, "profile" | "capture_configuration"> & HealthDependencies & { readonly runtime_configuration: RuntimeConfiguration }));

export function createApp(input: AppDependencies): Hono {
  const runtime = input.runtime_configuration ?? null;
  const deps: SourceDependencies & HealthDependencies = runtime ? { ...input,
    get profile() { return runtime.current().profile; },
    get capture_configuration() { return runtime.current().capture_configuration; },
    grader_capability: () => runtime.current().grader_capability,
  } : input as SourceDependencies & HealthDependencies;
  const app = new Hono();
  if (input.grading_config) registerGradingConfigRoutes(app, { ...input.grading_config, credentials: input.credentials });
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
