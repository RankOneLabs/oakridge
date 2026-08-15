import { Hono } from "hono";
import { z } from "zod";

import type { ProjectId, WorkflowDefinitionId } from "../domain/primitives";
import { CompatibleRunLaunchError, launchCompatibleRun, type LaunchRunDependencies } from "../runtime/launch-run";

const forgeRepository = z.object({ provider: z.literal("github"), owner: z.string().min(1), name: z.string().min(1) });
const epicProfile = z.object({
  title: z.string().min(1), slug: z.string().min(1),
  final_merge_policy: z.enum(["guarded", "external_confirmation"]),
  repositories: z.array(z.object({ repository_key: z.string().min(1), repository_path: z.string().min(1),
    base_branch: z.string().min(1), epic_branch: z.string().nullable().optional().transform((value) => value ?? null),
    forge_repository: forgeRepository.nullable().optional().transform((value) => value ?? null) })),
});
const launchSchema = z.object({ workflow_def_id: z.string().uuid(),
  project_id: z.string().uuid().nullable().optional().transform((value) => value ?? null),
  context: z.json().optional().default({}),
  epic_profile: epicProfile.nullable().optional().transform((value) => value ?? null) });

export const createRunLaunchApp = (dependencies: LaunchRunDependencies): Hono => {
  const app = new Hono();
  app.post("/workflow_runs", async (context) => {
    const parsed = launchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid workflow launch" }, 400);
    try {
      const summary = await launchCompatibleRun({ workflow_def_id: parsed.data.workflow_def_id as WorkflowDefinitionId,
        project_id: parsed.data.project_id as ProjectId | null, context: parsed.data.context,
        epic_profile: parsed.data.epic_profile, idempotency_key: context.req.header("idempotency-key")?.trim() || null }, dependencies);
      return context.json(summary, 201);
    } catch (error) {
      if (!(error instanceof CompatibleRunLaunchError)) return context.json({ error: error instanceof Error ? error.message : "workflow launch failed" }, 500);
      const status = error.kind === "definition_not_found" || error.kind === "project_not_found" ? 404
        : error.kind === "invalid_context" ? 400 : error.kind === "projection_unavailable" ? 503 : 409;
      return context.json({ error: error.message, code: error.kind }, status);
    }
  });
  return app;
};
