import type { StageDetail, StageUnit, PullRequestMergeWait } from "../types";
/** The projection reads this body from the cohort's frozen brief reference. */
export const selectCohortBrief = (unit: StageUnit): StageUnit["brief"] => unit.brief;

/** Repository cohorts need their worktree controls even when membership is one. */
export const selectStageHasCohortRows = (stage: StageDetail, merge_waits: readonly PullRequestMergeWait[] = []): boolean =>
  (stage.units?.length ?? 0) > 1 || (stage.units?.some((unit) => unit.worktree != null
    || merge_waits.some((wait) => wait.cohort_id === unit.cohort_id)) ?? false);

export const selectCohortArtifacts = (stage: StageDetail, cohort_id: string): StageDetail["artifacts"] =>
  stage.artifacts.filter((artifact) => artifact.cohort_id === cohort_id);

const GATE_LABELS: Readonly<Record<import("../../../../../oakridge-dbos/src/domain/dev-flow-v15").V15WorkerKey, string>> = {
  provision: "Repository preparation", spec: "Artifact review", plan: "Artifact review", brief: "Artifact review",
  build: "Artifact review", assessment: "Artifact review", final_integration: "Merge confirmation",
};
export const selectGateLabel = (worker: string): string =>
  Object.hasOwn(GATE_LABELS, worker) ? GATE_LABELS[worker as keyof typeof GATE_LABELS] : "Operator decision";
