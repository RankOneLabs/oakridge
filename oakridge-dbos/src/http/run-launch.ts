import { Hono } from "hono";
import { z } from "zod";

import { DELEGATED_RUNTIME_IDS } from "../domain/delegated-session";
import type { ProjectId, WorkflowDefinitionId } from "../domain/primitives";
import type { RunContext } from "../domain/run-context";
import { launchCompatibleRun, type LaunchRunDependencies, type RunLaunchFailureKind } from "../runtime/launch-run";

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

/**
 * The run context, as far as this boundary can know it.
 *
 * Deliberately loose about keys and strict about the ones it names. It was
 * `z.json()` — a scalar was a valid context, and `planner_runtime: 7` reached
 * the stage that would have run on it. But an authored definition may read any
 * pointer it likes, so a closed key list here would be a second copy of a
 * contract that lives in the definition. Which keys a given run *must* carry is
 * answered by the definition, at launch, in `unsatisfiedContextRequirements`.
 *
 * What is named here is the vocabulary every shipped dev-flow definition reads:
 * getting one of these wrong is a typo, and the failure it causes is many
 * stages away from the request that made it.
 */
const runtimeId = z.enum(DELEGATED_RUNTIME_IDS);
const contextSchema = z.looseObject({
  brief_notes: z.string().optional(),
  oakridge_url: z.string().min(1).optional(),
  // A model belongs to the runtime it was chosen from, so the pair travels
  // together; a null model is "whatever the runtime defaults to", not "absent".
  planner_runtime: runtimeId.optional(),
  planner_model: z.string().nullable().optional(),
  planner_effort: z.string().nullable().optional(),
  worker_runtime: runtimeId.optional(),
  worker_model: z.string().nullable().optional(),
  worker_effort: z.string().nullable().optional(),
  // `key` and `path` are what every consumer of a repository entry reads. The
  // branch fields are added by `prepareRunContext` from the epic profile, so a
  // caller supplying them is not required to.
  repositories: z.array(z.looseObject({ key: z.string().min(1), path: z.string().min(1) })).optional(),
});

const launchSchema = z.object({ workflow_def_id: z.string().uuid(),
  project_id: z.string().uuid().nullable().optional().transform((value) => value ?? null),
  context: contextSchema.optional().default({}),
  epic_profile: epicProfile.nullable().optional().transform((value) => value ?? null) });

/** Which fields a rejected request got wrong — a bare 400 makes the operator guess. */
const describeInvalidRequest = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`).join("; ");

export const createRunLaunchApp = (dependencies: LaunchRunDependencies): Hono => {
  const app = new Hono();
  app.post("/workflow_runs", async (context) => {
    const parsed = launchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: `invalid workflow launch — ${describeInvalidRequest(parsed.error)}`, code: "invalid_context" }, 400);
    const launched = await launchCompatibleRun({ workflow_def_id: parsed.data.workflow_def_id as WorkflowDefinitionId,
      project_id: parsed.data.project_id as ProjectId | null, context: parsed.data.context as RunContext,
      epic_profile: parsed.data.epic_profile, idempotency_key: context.req.header("idempotency-key")?.trim() || null }, dependencies);
    if (!launched.ok) return context.json({ error: launched.error.detail, code: launched.error.kind }, selectRunLaunchStatus(launched.error.kind));
    return context.json(launched.value, 201);
  });
  return app;
};
