import { join } from "node:path";
import type * as V15 from "../domain/dev-flow-v15";
import type { BuildBriefBody, PlanBody } from "../domain/dev-flow-artifacts";
import type { RepositoryRefsBody } from "../domain/dev-flow-v15";
import { err, ok, type CohortId, type StageInstanceId, type Result } from "../domain/primitives";
import { cohortIdFor } from "./ids";
import { isLegalCohortKey, validatePlanCohorts, validateBriefCollection } from "./schedule-cohorts";

export interface PinnedRepository { readonly ref: V15.ArtifactRef; readonly body: RepositoryRefsBody }
export interface PinnedPlan { readonly ref: V15.ArtifactRef; readonly body: PlanBody }
export interface PinnedBrief { readonly ref: V15.ArtifactRef; readonly body: BuildBriefBody }
export type StageInputs = V15.RepositoryPreparationInputs | V15.SpecAnalysisInputs | V15.PlanningInputs
  | V15.BriefWritingInputs | V15.ImplementationCohortInputs | V15.FinalIntegrationInputs;
export interface NewStageCohort<Inputs extends StageInputs = StageInputs> {
  readonly id: CohortId;
  readonly cohort_key: string;
  readonly depends_on: readonly CohortId[];
  readonly frozen_inputs: Inputs;
  readonly workers: readonly V15.V15WorkerKey[];
}
export interface StageMaterializationError {
  readonly operation: "materialize_stage";
  readonly stage_instance_id: StageInstanceId;
  readonly kind: "empty_membership" | "invalid_mapping" | "upstream_unavailable";
  readonly detail: string;
}
export interface StageMaterializationSource {
  readonly stage_instance_id: StageInstanceId;
  readonly run: V15.V15RunInputs;
  readonly repositories: readonly PinnedRepository[];
  readonly analysis: V15.ArtifactRef | null;
  readonly plan: PinnedPlan | null;
  readonly briefs: readonly PinnedBrief[];
  readonly completed: readonly V15.CompletedImplementation[];
}
type MaterializationResult = Result<readonly NewStageCohort[], StageMaterializationError>;
const failure = (source: StageMaterializationSource, kind: StageMaterializationError["kind"], detail: string): MaterializationResult =>
  err({ operation: "materialize_stage", stage_instance_id: source.stage_instance_id, kind, detail });
const seed = <Inputs extends StageInputs>(source: StageMaterializationSource, key: string,
  inputs: Inputs, workers: readonly V15.V15WorkerKey[], depends_on: readonly CohortId[] = []): NewStageCohort<Inputs> => ({
  id: cohortIdFor(source.stage_instance_id, key), cohort_key: key, frozen_inputs: inputs, workers, depends_on,
});
const preparedRefs = (source: StageMaterializationSource): readonly V15.PreparedRepositoryArtifact[] =>
  source.repositories.map((repository) => ({ repository_key: repository.body.repository_key as V15.PreparedRepositoryArtifact["repository_key"], ref: repository.ref }));
const validateRepositories = (source: StageMaterializationSource): boolean =>
  source.repositories.length === source.run.repositories.length
  && source.run.repositories.every((repository) => source.repositories.filter((prepared) => prepared.body.repository_key === repository.key).length === 1);

export const createRepositoryPreparationCohorts = (source: StageMaterializationSource): MaterializationResult => {
  const repositories = source.run.repositories;
  if (!repositories.length) return failure(source, "empty_membership", "run has no repositories");
  if (new Set(repositories.map((repository) => repository.key)).size !== repositories.length
    || repositories.some((repository) => !isLegalCohortKey(repository.key)))
    return failure(source, "invalid_mapping", "repository keys must be unique legal branch and path segments");
  return ok(repositories.map((repository) => seed(source, repository.key,
    { repository, base_branch: source.run.base_branch }, ["provision"])));
};
export const createSpecAnalysisCohorts = (source: StageMaterializationSource): MaterializationResult =>
  validateRepositories(source) ? ok([seed(source, "spec_analysis", {
    brief_notes: source.run.brief_notes, repositories: preparedRefs(source),
  }, ["spec"])]) : failure(source, "upstream_unavailable", "accepted repository refs do not cover the supplied repositories");
export const createPlanningCohorts = (source: StageMaterializationSource): MaterializationResult =>
  source.analysis && validateRepositories(source) ? ok([seed(source, "planning", {
    spec_analysis: source.analysis, repositories: preparedRefs(source),
  }, ["plan"])]) : failure(source, "upstream_unavailable", "accepted analysis or repository refs are missing");
export const createBriefWritingCohorts = (source: StageMaterializationSource): MaterializationResult => {
  if (!source.plan || !validateRepositories(source)) return failure(source, "upstream_unavailable", "accepted plan or repository refs are missing");
  const validated = validatePlanCohorts(source.plan.body, new Set(source.run.repositories.map((repository) => repository.key)));
  if (!validated.ok) return failure(source, "invalid_mapping", `${validated.error.kind}: ${validated.error.detail}`);
  return ok([seed(source, "brief_writing", { plan: source.plan.ref, repositories: preparedRefs(source) }, ["brief"])]);
};
export const createImplementationCohorts = (source: StageMaterializationSource): MaterializationResult => {
  if (!source.plan || !validateRepositories(source)) return failure(source, "upstream_unavailable", "accepted plan or repository refs are missing");
  const plan = validatePlanCohorts(source.plan.body, new Set(source.run.repositories.map((repository) => repository.key)));
  if (!plan.ok) return failure(source, "invalid_mapping", `${plan.error.kind}: ${plan.error.detail}`);
  const briefs = validateBriefCollection(plan.value, source.briefs.map((brief) => brief.body));
  if (!briefs.ok) return failure(source, "invalid_mapping", `${briefs.error.kind}: ${briefs.error.detail}`);
  return ok(plan.value.map((cohort) => {
    // Coverage was proved above; find by identity, never by collection position.
    const brief = source.briefs.find((candidate) => candidate.body.cohort_id === cohort.id)!;
    const repository = source.repositories.find((candidate) => candidate.body.repository_key === cohort.repository_key)!;
    return seed(source, cohort.id, { brief: brief.ref, repository: {
      refs: repository.body, canonical_branch: `cohort/${source.stage_instance_id}/${cohort.id}`,
      expected_pr_base: repository.body.base_branch,
      worktree_path: join(repository.body.repository_path, ".worktrees", "oakridge", source.stage_instance_id, cohort.id),
      worktree_base_sha: null,
    } }, ["build", "assessment"], cohort.depends_on.map((key) => cohortIdFor(source.stage_instance_id, key)));
  }));
};
export const createFinalIntegrationCohorts = (source: StageMaterializationSource): MaterializationResult => {
  if (!source.plan) return failure(source, "upstream_unavailable", "accepted plan is missing");
  const plan = validatePlanCohorts(source.plan.body, new Set(source.run.repositories.map((repository) => repository.key)));
  if (!plan.ok) return failure(source, "invalid_mapping", `${plan.error.kind}: ${plan.error.detail}`);
  if (source.completed.length !== plan.value.length
    || plan.value.some((cohort) => source.completed.filter((completed) => completed.cohort_key === cohort.id
      && completed.repository_key === cohort.repository_key).length !== 1))
    return failure(source, "invalid_mapping", "completed implementations do not cover the accepted plan");
  const keys = [...new Set(plan.value.map((cohort) => cohort.repository_key))];
  const created: NewStageCohort[] = [];
  for (const key of keys) {
    const repository = source.repositories.find((candidate) => candidate.body.repository_key === key);
    if (!repository) return failure(source, "upstream_unavailable", `accepted repository refs missing for ${key}`);
    created.push(seed(source, key, { repository: repository.body,
      completed_cohorts: source.completed.filter((completed) => completed.repository_key === key) }, ["final_integration"]));
  }
  return created.length ? ok(created) : failure(source, "empty_membership", "final integration has no used repositories");
};
export const materializeStage = (stage: V15.StageKey, source: StageMaterializationSource): MaterializationResult => {
  switch (stage) {
    case "repository_preparation": return createRepositoryPreparationCohorts(source);
    case "spec_analysis": return createSpecAnalysisCohorts(source);
    case "planning": return createPlanningCohorts(source);
    case "brief_writing": return createBriefWritingCohorts(source);
    case "implementation": return createImplementationCohorts(source);
    case "final_integration": return createFinalIntegrationCohorts(source);
  }
};
