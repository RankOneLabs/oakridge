import { Hono } from "hono";
import { z } from "zod";

import type { JsonValue, WorkflowDefinitionId, WorkflowRunId } from "../domain/primitives";
import { launchRun, type LaunchRunDependencies } from "../runtime/launch-run";

const launchSchema = z.object({ run_id: z.string().uuid(), workflow_definition_id: z.string().uuid(), context: z.json(), application_version: z.string().min(1).optional() });
export const createRunLaunchApp = (dependencies: LaunchRunDependencies): Hono => {
  const app = new Hono();
  app.post("/workflow_runs", async (context) => {
    const parsed = launchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid workflow launch" }, 400);
    try {
      const result = await launchRun({ run_id: parsed.data.run_id as WorkflowRunId, workflow_definition_id: parsed.data.workflow_definition_id as WorkflowDefinitionId,
        context: parsed.data.context as JsonValue, application_version: parsed.data.application_version }, dependencies);
      return context.json(result, 202);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "workflow launch failed" }, 409);
    }
  });
  return app;
};
