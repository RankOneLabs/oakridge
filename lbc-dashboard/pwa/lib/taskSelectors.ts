import type {
  GraderConfigDraft,
  GraderSummary,
  TaskDetail,
  TaskSummary,
} from "../../src/contracts";

export function taskSourceLabel(task: Pick<TaskSummary, "source">): string {
  return task.source === "builtin" ? "Built-in" : "Saved";
}

export function taskLaunchLabel(
  task: TaskDetail,
  graders: GraderSummary[],
  graderConfigs: GraderConfigDraft[],
): string {
  if (task.source === "builtin") {
    return "Available to launch";
  }
  const graderKey =
    task.grader.kind === "registered" ? task.grader.key : null;
  if (graderKey === null) {
    return "No grader";
  }
  const grader = graders.find((entry) => entry.key === graderKey);
  if (
    grader === undefined ||
    !grader.supported_artifact_types.includes(task.artifact_type)
  ) {
    return "Invalid grader config";
  }
  const hasConfig = graderConfigs.some(
    (entry) => entry.task_name === task.name && entry.grader_key === graderKey,
  );
  return hasConfig ? "Grader configured" : "Available to launch";
}

export function taskStateLabels(
  task: TaskDetail,
  graders: GraderSummary[],
  graderConfigs: GraderConfigDraft[],
): string[] {
  if (task.source === "builtin") {
    return [taskSourceLabel(task), "Available to launch"];
  }
  return [
    taskSourceLabel(task),
    taskLaunchLabel(task, graders, graderConfigs),
  ];
}

export function taskSummaryStateLabels(
  task: Pick<TaskSummary, "artifact_type" | "name" | "source" | "has_grader" | "grader_key">,
  graders: GraderSummary[],
  graderConfigs: GraderConfigDraft[],
): string[] {
  const sourceLabel = taskSourceLabel(task);
  if (task.source === "builtin") {
    return [sourceLabel, "Available to launch"];
  }
  if (!task.has_grader || task.grader_key === null) {
    return [sourceLabel, "No grader"];
  }
  const grader = graders.find((entry) => entry.key === task.grader_key);
  if (
    grader === undefined ||
    !grader.supported_artifact_types.includes(task.artifact_type)
  ) {
    return [sourceLabel, "Invalid grader config"];
  }
  const hasConfig = graderConfigs.some(
    (entry) =>
      entry.task_name === task.name && entry.grader_key === task.grader_key,
  );
  return [sourceLabel, hasConfig ? "Grader configured" : "Available to launch"];
}

export function graderConfigRequirementLabel(
  grader: Pick<GraderSummary, "config_required">,
): string {
  return grader.config_required ? "Config required" : "No config required";
}
