import { err, ok, type ArtifactId, type Result, type StageInstanceId } from "../domain/primitives";
import type { Command, Contradiction, Derivation, StatusChange } from "./commands";
import type { CohortSnapshot, RunSnapshot, StageSnapshot } from "./snapshot";

const byId = <Value extends { readonly id: string }>(left: Value, right: Value): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

const noEffect = { kind: "none" } as const;
const active: StatusChange = { status: "active", blocked_reason: null, next_actor: "core", outcome: null };
const complete: StatusChange = { status: "complete", blocked_reason: null, next_actor: null, outcome: { kind: "succeeded" } };

const validateGraph = (stages: readonly StageSnapshot[]): Result<ReadonlyMap<StageInstanceId, StageSnapshot>, Contradiction> => {
  const indexed = new Map<StageInstanceId, StageSnapshot>();
  for (const stage of stages) {
    if (indexed.has(stage.id)) return err({ kind: "duplicate_stage", stage_instance_id: stage.id });
    indexed.set(stage.id, stage);
  }
  for (const stage of stages) for (const dependency of stage.dependency_stage_instance_ids) {
    if (!indexed.has(dependency)) return err({ kind: "unknown_stage_dependency", stage_instance_id: stage.id, dependency_stage_instance_id: dependency });
  }
  return ok(indexed);
};

const observedArtifacts = (stages: readonly StageSnapshot[]): readonly ArtifactId[] =>
  [...new Set(stages.flatMap((stage) => [
    ...stage.accepted_artifact_ids,
    ...stage.cohorts.flatMap((cohort) => cohort.accepted_artifact_ids),
  ]))].sort();

const terminalRunCommand = (snapshot: RunSnapshot, failed: StageSnapshot): Command => {
  const status = failed.status === "cancelled" ? "cancelled" : "failed";
  return {
    kind: "transition_run",
    run_id: snapshot.run.id,
    expected_version: snapshot.run.record_version,
    change: { status, blocked_reason: null, next_actor: null,
      outcome: failed.outcome ?? { kind: status, stage_instance_id: failed.id } },
    effect: noEffect,
  };
};

const terminalStageCommand = (snapshot: RunSnapshot, stage: StageSnapshot, cohort: CohortSnapshot): Command => {
  const status = cohort.status === "cancelled" ? "cancelled" : "failed";
  return {
    kind: "transition_stage",
    run_id: snapshot.run.id,
    stage_instance_id: stage.id,
    expected_version: stage.durable_version,
    change: { status, blocked_reason: null, next_actor: null,
      outcome: cohort.outcome ?? { kind: status, cohort_id: cohort.id } },
    effect: noEffect,
  };
};

const isUnfinished = (status: StageSnapshot["status"]): boolean =>
  status === "pending" || status === "active" || status === "blocked";

/** Cancel siblings before publishing their owner's terminal outcome. */
const cancelStageWork = (snapshot: RunSnapshot, stage: StageSnapshot): readonly Command[] =>
  [...stage.cohorts].sort(byId).filter((cohort) => isUnfinished(cohort.status)).map((cohort): Command => ({
    kind: "transition_cohort", run_id: snapshot.run.id, cohort_id: cohort.id,
    expected_version: cohort.durable_version,
    change: { status: "cancelled", blocked_reason: null, next_actor: null, outcome: { kind: "cancelled" } },
    effect: noEffect,
  }));

const stopRun = (snapshot: RunSnapshot, terminal: StageSnapshot): readonly Command[] => [
  ...[...snapshot.stages].sort(byId).flatMap((stage): readonly Command[] => [
    ...cancelStageWork(snapshot, stage),
    ...(isUnfinished(stage.status) ? [{ kind: "transition_stage" as const, run_id: snapshot.run.id,
      stage_instance_id: stage.id, expected_version: stage.durable_version,
      change: { status: "cancelled" as const, blocked_reason: null, next_actor: null, outcome: { kind: "cancelled" } },
      effect: noEffect }] : []),
  ]),
  terminalRunCommand(snapshot, terminal),
];

const stageWithTerminalCohort = (
  stages: readonly StageSnapshot[],
  status: "cancelled" | "failed",
): { readonly stage: StageSnapshot; readonly cohort: CohortSnapshot } | null => {
  for (const stage of stages) {
    if (stage.status !== "active") continue;
    const cohort = [...stage.cohorts].sort(byId).find((candidate) => candidate.status === status);
    if (cohort) return { stage, cohort };
  }
  return null;
};

/**
 * The whole core decision, evaluated once over a transaction-consistent run
 * snapshot. Adapters have already decoded payloads into committed statuses and
 * artifact identities; this function has no artifact-body interpretation.
 */
export const derive = (snapshot: RunSnapshot): Result<Derivation, Contradiction> => {
  const graph = validateGraph(snapshot.stages);
  if (!graph.ok) return graph;
  const stages = [...snapshot.stages].sort(byId);
  const observed_artifact_ids = observedArtifacts(stages);
  if (snapshot.run.status === "complete" || snapshot.run.status === "failed" || snapshot.run.status === "cancelled") {
    return ok({ commands: [], observed_artifact_ids });
  }

  const failed = stages.find((stage) => stage.status === "failed");
  if (failed) return ok({ commands: stopRun(snapshot, failed), observed_artifact_ids });
  const failedCohort = stageWithTerminalCohort(stages, "failed");
  if (failedCohort) return ok({ commands: [...cancelStageWork(snapshot, failedCohort.stage), terminalStageCommand(snapshot, failedCohort.stage, failedCohort.cohort)], observed_artifact_ids });
  const cancelled = stages.find((stage) => stage.status === "cancelled");
  if (cancelled) return ok({ commands: stopRun(snapshot, cancelled), observed_artifact_ids });
  const cancelledCohort = stageWithTerminalCohort(stages, "cancelled");
  if (cancelledCohort) return ok({ commands: [...cancelStageWork(snapshot, cancelledCohort.stage), terminalStageCommand(snapshot, cancelledCohort.stage, cancelledCohort.cohort)], observed_artifact_ids });

  const commands: Command[] = [];
  for (const stage of stages) {
    if (stage.status === "active" && stage.cohorts.length > 0 && stage.cohorts.every((cohort) => cohort.status === "complete")) {
      commands.push({ kind: "transition_stage", run_id: snapshot.run.id, stage_instance_id: stage.id,
        expected_version: stage.durable_version, change: complete, effect: noEffect });
      continue;
    }
    if (stage.status === "pending" && stage.dependency_stage_instance_ids.every((id) => graph.value.get(id)?.status === "complete")) {
      commands.push({ kind: "transition_stage", run_id: snapshot.run.id, stage_instance_id: stage.id,
        expected_version: stage.durable_version, change: active,
        effect: { kind: "start_stage", stage_instance_id: stage.id } });
    }
  }

  if (commands.length === 0 && stages.length > 0 && stages.every((stage) => stage.status === "complete")) {
    commands.push({ kind: "transition_run", run_id: snapshot.run.id, expected_version: snapshot.run.record_version,
      change: complete, effect: noEffect });
  }
  return ok({ commands, observed_artifact_ids });
};
