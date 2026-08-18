import { Hono } from "hono";
import { z } from "zod";

import type { ProjectId, WorkflowDefinitionId } from "../domain/primitives";
import { launchCompatibleRun, type LaunchRunDependencies, type RunLaunchFailureKind } from "../runtime/launch-run";

/** The HTTP reading of a launch failure — one place, exhaustive over the union. */
const selectRunLaunchStatus = (kind: RunLaunchFailureKind): 400 | 404 | 409 | 503 => {
  if (kind === "definition_not_found" || kind === "project_not_found") return 404;
  // A repository the run cannot work in is the request being unsatisfiable,
  // not a conflict with existing state — and it is fixable by the caller.
  if (kind === "invalid_context" || kind === "repository_precondition_unmet") return 400;
  if (kind === "projection_unavailable") return 503;
  return 409;
};

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
    const launched = await launchCompatibleRun({ workflow_def_id: parsed.data.workflow_def_id as WorkflowDefinitionId,
      project_id: parsed.data.project_id as ProjectId | null, context: parsed.data.context,
      epic_profile: parsed.data.epic_profile, idempotency_key: context.req.header("idempotency-key")?.trim() || null }, dependencies);
    if (!launched.ok) return context.json({ error: launched.error.detail, code: launched.error.kind }, selectRunLaunchStatus(launched.error.kind));
    return context.json(launched.value, 201);
  });
  return app;
};
