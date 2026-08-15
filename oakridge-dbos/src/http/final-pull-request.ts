import { Hono } from "hono";
import { z } from "zod";

import type { WorkflowRunId } from "../domain/primitives";
import type { FinalPullRequestProjection } from "../domain/final-pull-request";
import type { FinalPullRequestRepository } from "../storage/repositories";

export interface FinalPullRequestHttpDependencies {
  readonly final_pull_requests: FinalPullRequestRepository;
  readonly now?: () => string;
}

const observationSchema = z.object({
  observation: z.object({
    provider: z.literal("github"),
    owner: z.string().min(1),
    name: z.string().min(1),
    number: z.number().int().positive(),
    url: z.string().min(1),
    head_branch: z.string().min(1),
    base_branch: z.string().min(1),
    head_sha: z.string().min(1).nullable(),
    state: z.enum(["open", "merged", "closed_unmerged"]),
    source: z.enum(["poll", "webhook", "manual_recheck"]),
    observed_at: z.string().min(1),
    merged_at: z.string().min(1).nullable(),
  }),
});

const confirmationSchema = z.object({
  idempotency_key: z.string(),
  operator_comment: z.string().optional(),
});

const publicProjection = ({ outcome, profile }: FinalPullRequestProjection) => ({ outcome, profile });
const errorStatus = (kind: string): 404 | 409 => kind === "profile_not_found" ? 404 : 409;

export const createFinalPullRequestApp = (dependencies: FinalPullRequestHttpDependencies): Hono => {
  const app = new Hono();
  const now = dependencies.now ?? (() => new Date().toISOString());

  app.post("/workflow_runs/:runId/final_pull_requests/:repositoryKey/observations", async (http) => {
    const parsed = observationSchema.safeParse(await http.req.json().catch(() => null));
    if (!parsed.success) return http.json({ error: "invalid final pull request observation" }, 400);
    const result = await dependencies.final_pull_requests.observe({
      run_id: http.req.param("runId") as WorkflowRunId,
      repository_key: http.req.param("repositoryKey"),
      observation: parsed.data.observation,
      updated_at: now(),
    });
    return result.ok
      ? http.json(publicProjection(result.value))
      : http.json({ error: result.error.detail, code: result.error.kind }, errorStatus(result.error.kind));
  });

  app.post("/workflow_runs/:runId/final_pull_requests/:repositoryKey/confirm", async (http) => {
    const parsed = confirmationSchema.safeParse(await http.req.json().catch(() => null));
    if (!parsed.success) return http.json({ error: "invalid final pull request confirmation" }, 400);
    const result = await dependencies.final_pull_requests.confirm({
      run_id: http.req.param("runId") as WorkflowRunId,
      repository_key: http.req.param("repositoryKey"),
      request: parsed.data,
      confirmed_at: now(),
    });
    return result.ok
      ? http.json(publicProjection(result.value))
      : http.json({ error: result.error.detail, code: result.error.kind }, errorStatus(result.error.kind));
  });

  return app;
};
