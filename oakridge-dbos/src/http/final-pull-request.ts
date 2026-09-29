import { Hono } from "hono";
import { z } from "zod";

import type { BuildCohortEvent } from "../adapters/dev-flow-build";
import { selectFinalPullRequestObservationOutcome, type FinalPullRequestEvent } from "../domain/final-pull-request";
import type { DevFlowBuildCohort } from "../domain/cohort-pull-request";
import type { FinalMergePolicy } from "../domain/epic";
import { parseUuidId, type CohortId, type UnitId, type WorkflowRunId } from "../domain/primitives";
import type { PullRequestVerificationId } from "../domain/pull-request";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import { verifyAndBindCohortPullRequest, type PullRequestForgeReader } from "../runtime/cohort-pull-request";
import type { DevFlowPullRequestRepository } from "../storage/repositories";

export interface FinalPullRequestTarget {
  readonly cohort: DevFlowBuildCohort;
  readonly forge_repository: { readonly owner: string; readonly name: string };
  readonly merge_policy: FinalMergePolicy;
}

export interface FinalPullRequestTargetRepository {
  find(run_id: WorkflowRunId, repository_key: string): Promise<FinalPullRequestTarget | null>;
}

export interface FinalPullRequestHttpDependencies {
  readonly pull_requests: DevFlowPullRequestRepository;
  readonly final_targets: FinalPullRequestTargetRepository;
  readonly pull_request_reader: PullRequestForgeReader;
  readonly git: GitCommandRunner;
  readonly record_build_event: (cohort_id: CohortId, event: BuildCohortEvent) => Promise<void>;
  readonly record_final_event: (event: FinalPullRequestEvent) => Promise<void>;
  readonly now?: () => string;
}

const observationSchema = z.object({
  pull_request_url: z.string().min(1),
  replace_verification_id: z.string().uuid().nullable().optional(),
});

const confirmationSchema = z.object({
  idempotency_key: z.string().trim().min(1),
  operator_comment: z.string().optional(),
});

export const createFinalPullRequestApp = (dependencies: FinalPullRequestHttpDependencies): Hono => {
  const app = new Hono();
  const now = dependencies.now ?? (() => new Date().toISOString());

  app.post("/workflow_runs/:runId/final_pull_requests/:repositoryKey/observations", async (http) => {
    const parsed = observationSchema.safeParse(await http.req.json().catch(() => null));
    if (!parsed.success) return http.json({ error: "invalid final pull request observation" }, 400);
    const runId = parseUuidId<WorkflowRunId>(http.req.param("runId"));
    if (!runId) return http.json({ error: "workflow run was not found" }, 404);
    const target = await dependencies.final_targets.find(runId, http.req.param("repositoryKey"));
    if (!target) return http.json({ error: "final pull request target was not found", code: "profile_not_found" }, 404);
    const verified = await verifyAndBindCohortPullRequest({ pull_requests: dependencies.pull_requests,
      reader: dependencies.pull_request_reader, git: dependencies.git, now,
      record_build_event: dependencies.record_build_event }, {
      cohort: target.cohort, forge_repository: target.forge_repository, candidate_url: parsed.data.pull_request_url,
      replace_verification_id: (parsed.data.replace_verification_id ?? null) as PullRequestVerificationId | null,
    });
    if (!verified.ok) return http.json({ error: verified.error.detail, code: verified.error.kind }, 409);
    await dependencies.record_final_event({ kind: "pull_request_verified", cohort_id: target.cohort.cohort_id,
      verification_id: verified.value.verification_id, revision: verified.value.pushed_head_sha,
      pull_request_url: verified.value.observation.url, state: verified.value.observation.state });
    return http.json({ outcome: selectFinalPullRequestObservationOutcome(verified.value.observation),
      pull_request_url: verified.value.observation.url, verification_id: verified.value.verification_id,
      binding: verified.value.binding });
  });

  app.post("/workflow_runs/:runId/final_pull_requests/:repositoryKey/confirm", async (http) => {
    const parsed = confirmationSchema.safeParse(await http.req.json().catch(() => null));
    if (!parsed.success) return http.json({ error: "invalid final pull request confirmation" }, 400);
    const runId = parseUuidId<WorkflowRunId>(http.req.param("runId"));
    if (!runId) return http.json({ error: "workflow run was not found" }, 404);
    const target = await dependencies.final_targets.find(runId, http.req.param("repositoryKey"));
    if (!target) return http.json({ error: "final pull request target was not found", code: "profile_not_found" }, 404);
    if (target.merge_policy !== "external_confirmation") {
      return http.json({ error: "explicit confirmation is only valid for external_confirmation policy", code: "invalid_policy" }, 409);
    }
    const current = await dependencies.pull_requests.find_current_for_unit(target.cohort.stage_instance_id, target.cohort.cohort_key as UnitId);
    if (!current || current.observation.state !== "merged" || !current.observation.merged_at) {
      return http.json({ error: "final pull request has no verified merged observation", code: "missing_merged_evidence" }, 409);
    }
    const closure = await dependencies.pull_requests.confirm_merge({ cohort_id: target.cohort.cohort_id,
      pull_request_id: current.pull_request.id, idempotency_key: parsed.data.idempotency_key,
      merged_at: current.observation.merged_at, confirmed_at: now() });
    if (!closure.ok) return http.json({ error: closure.error.detail, code: closure.error.kind }, 409);
    await dependencies.record_final_event({ kind: "pull_request_merge_confirmed", cohort_id: target.cohort.cohort_id,
      pull_request_url: current.pull_request.url, confirmation: closure.value.kind,
      operator_comment: parsed.data.operator_comment ?? null });
    return http.json({ outcome: "completed", pull_request_url: current.pull_request.url,
      confirmation: closure.value.kind, closure: closure.value.closure });
  });

  return app;
};
