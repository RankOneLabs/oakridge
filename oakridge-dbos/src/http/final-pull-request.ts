import { Hono } from "hono";
import { z } from "zod";

import { parseUuidId, type UnitId, type WorkflowRunId } from "../domain/primitives";
import type { FinalPullRequestProjection } from "../domain/final-pull-request";
import type { DevFlowPullRequestRepository, FinalPullRequestRepository } from "../storage/repositories";
import type { DevFlowBuildCohort } from "../domain/cohort-pull-request";
import type { PullRequestVerificationId } from "../domain/pull-request";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import { verifyCohortPullRequest, type PullRequestForgeReader } from "../runtime/cohort-pull-request";

export interface FinalPullRequestTarget {
  readonly cohort: DevFlowBuildCohort;
  readonly forge_repository: { readonly owner: string; readonly name: string };
}

export interface FinalPullRequestTargetRepository {
  find(run_id: WorkflowRunId, repository_key: string): Promise<FinalPullRequestTarget | null>;
}

export interface FinalPullRequestHttpDependencies {
  readonly final_pull_requests: FinalPullRequestRepository;
  readonly pull_requests: DevFlowPullRequestRepository;
  readonly final_targets: FinalPullRequestTargetRepository;
  readonly pull_request_reader: PullRequestForgeReader;
  readonly git: GitCommandRunner;
  readonly now?: () => string;
}

const observationSchema = z.object({
  pull_request_url: z.string().min(1),
  replace_verification_id: z.string().uuid().nullable().optional(),
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
    const runId = parseUuidId<WorkflowRunId>(http.req.param("runId"));
    if (!runId) return http.json({ error: "workflow run was not found" }, 404);
    const repositoryKey = http.req.param("repositoryKey");
    const target = await dependencies.final_targets.find(runId, repositoryKey);
    if (!target) return http.json({ error: "final pull request target was not found", code: "profile_not_found" }, 404);
    const verified = await verifyCohortPullRequest({ reader: dependencies.pull_request_reader, git: dependencies.git }, {
      cohort: target.cohort, forge_repository: target.forge_repository, candidate_url: parsed.data.pull_request_url,
    });
    if (!verified.ok) return http.json({ error: verified.error.detail, code: verified.error.kind }, 409);
    const stored = await dependencies.pull_requests.observe({ repository_key: target.cohort.repository_key,
      observation: verified.value.observation, recorded_at: now() });
    const current = await dependencies.pull_requests.find_current_for_unit(target.cohort.stage_instance_id, target.cohort.cohort_key as UnitId);
    const isSameVerifiedHead = current?.pull_request.id === stored.pull_request_id
      && current.observation.head_sha === verified.value.pushed_head_sha;
    if (!isSameVerifiedHead) {
      const bound = await dependencies.pull_requests.bind_verified({ cohort_id: target.cohort.cohort_id, ...stored,
        verified_head_sha: verified.value.pushed_head_sha, verified_at: now(),
        replace_verification_id: (parsed.data.replace_verification_id ?? null) as PullRequestVerificationId | null });
      if (!bound.ok) return http.json({ error: bound.error.detail, code: bound.error.kind }, 409);
    }
    const result = await dependencies.final_pull_requests.observe({
      run_id: runId,
      repository_key: repositoryKey,
      observation: verified.value.observation,
      updated_at: now(),
    });
    return result.ok
      ? http.json(publicProjection(result.value))
      : http.json({ error: result.error.detail, code: result.error.kind }, errorStatus(result.error.kind));
  });

  app.post("/workflow_runs/:runId/final_pull_requests/:repositoryKey/confirm", async (http) => {
    const parsed = confirmationSchema.safeParse(await http.req.json().catch(() => null));
    if (!parsed.success) return http.json({ error: "invalid final pull request confirmation" }, 400);
    const runId = parseUuidId<WorkflowRunId>(http.req.param("runId"));
    if (!runId) return http.json({ error: "workflow run was not found" }, 404);
    const repositoryKey = http.req.param("repositoryKey");
    const target = await dependencies.final_targets.find(runId, repositoryKey);
    if (!target) return http.json({ error: "final pull request target was not found", code: "profile_not_found" }, 404);
    const current = await dependencies.pull_requests.find_current_for_unit(target.cohort.stage_instance_id, target.cohort.cohort_key as UnitId);
    if (!current || current.observation.state !== "merged" || !current.observation.merged_at) {
      return http.json({ error: "final pull request has no verified merged observation", code: "missing_merged_evidence" }, 409);
    }
    const closure = await dependencies.pull_requests.confirm_merge({ cohort_id: target.cohort.cohort_id,
      pull_request_id: current.pull_request.id, idempotency_key: parsed.data.idempotency_key,
      merged_at: current.observation.merged_at, confirmed_at: now() });
    if (!closure.ok) return http.json({ error: closure.error.detail, code: closure.error.kind }, 409);
    const result = await dependencies.final_pull_requests.confirm({
      run_id: runId,
      repository_key: repositoryKey,
      request: parsed.data,
      confirmed_at: now(),
    });
    return result.ok
      ? http.json(publicProjection(result.value))
      : http.json({ error: result.error.detail, code: result.error.kind }, errorStatus(result.error.kind));
  });

  return app;
};
