import { Hono } from "hono";
import { z } from "zod";

import { DELEGATED_RUNTIME_IDS } from "../domain/delegated-session";
import type { ProjectId, WorkflowDefinitionId } from "../domain/primitives";
import type { RunContext } from "../domain/run-context";
import { launchRun, type LaunchRunDependencies, type RunLaunchFailureKind } from "../runtime/launch-run";

/** The HTTP reading of a launch failure — one place, exhaustive over the union. */
const selectRunLaunchStatus = (kind: RunLaunchFailureKind): 400 | 404 | 409 | 503 => {
  if (kind === "definition_not_found" || kind === "project_not_found") return 404;
  if (kind === "invalid_context" || kind === "context_requirements_unmet") return 400;
  if (kind === "projection_unavailable") return 503;
  return 409;
};

const forgeRepository = z.object({ provider: z.literal("github"), owner: z.string().min(1), name: z.string().min(1) });
const epicProfile = z.object({
  title: z.string().min(1), slug: z.string().min(1),
  final_merge_policy: z.enum(["guarded", "external_confirmation"]),
  // One base branch for the epic, defaulting to `epic/<slug>`. It was declared
  // per repository, so a two-repo epic could name two different branches for
  // the one thing every stage calls "the base branch".
  base_branch: z.string().min(1).nullable().optional().transform((value) => value ?? null),
  repositories: z.array(z.object({ repository_key: z.string().min(1), repository_path: z.string().min(1),
    integration_branch: z.string().min(1),
    forge_repository: forgeRepository.nullable().optional().transform((value) => value ?? null) })),
});

/** Grouped agent settings are required; project metadata supplies repository defaults. */
const runtimeId = z.enum(DELEGATED_RUNTIME_IDS);
const settings = z.object({ runtime: runtimeId, model: z.string().nullable(), effort: z.string().nullable() });
const contextSchema = z.looseObject({
  brief_notes: z.string().optional(),
  oakridge_url: z.string().min(1).optional(),
  // The run's one base branch. `prepareRunContext` overwrites this from the epic
  // profile when there is one, but a launch without a profile passes the
  // caller's value straight through to a `git push` that creates the branch —
  // so a `null` here became a branch literally named "null".
  base_branch: z.string().min(1).refine((value) => value === value.trim(),
    { message: "must not have leading or trailing whitespace" }).optional(),
  // A model belongs to the runtime it was chosen from, so the pair travels
  // together; a null model is "whatever the runtime defaults to", not "absent".
  planner: settings,
  builder: settings,
  // `key` and `path` are what every consumer of a repository entry reads. The
  // branch fields are added by `prepareRunContext` from the epic profile, so a
  // caller supplying them is not required to.
  repositories: z.array(z.looseObject({ key: z.string().min(1), path: z.string().min(1) })).optional(),
});

const launchSchema = z.object({ workflow_def_id: z.string().uuid(),
  project_id: z.string().uuid().nullable().optional().transform((value) => value ?? null),
  context: contextSchema,
  epic_profile: epicProfile.nullable().optional().transform((value) => value ?? null) });

/** Which fields a rejected request got wrong — a bare 400 makes the operator guess. */
const describeInvalidRequest = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`).join("; ");

export const createRunLaunchApp = (dependencies: LaunchRunDependencies): Hono => {
  const app = new Hono();
  app.post("/workflow_runs", async (context) => {
    const parsed = launchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: `invalid workflow launch — ${describeInvalidRequest(parsed.error)}`, code: "invalid_context" }, 400);
    const launched = await launchRun({ workflow_def_id: parsed.data.workflow_def_id as WorkflowDefinitionId,
      project_id: parsed.data.project_id as ProjectId | null, context: parsed.data.context as RunContext,
      epic_profile: parsed.data.epic_profile, idempotency_key: context.req.header("idempotency-key")?.trim() || null }, dependencies);
    if (!launched.ok) return context.json({ error: launched.error.detail, code: launched.error.kind }, selectRunLaunchStatus(launched.error.kind));
    return context.json(launched.value, 201);
  });
  return app;
};
