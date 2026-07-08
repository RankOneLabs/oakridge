import { LBC_STUDY_MODEL_CATALOG } from "../../../src/generated/model_catalog";
import { RunSpecSchema } from "../../lib/types";
import type { ConditionSpec, RunSpec, TaskSummary } from "../../lib/types";

/** Models offered as quick-pick checkboxes in the launch form, in display order. */
export const FORM_MODELS = LBC_STUDY_MODEL_CATALOG.filter((m) => m.inForm);

export interface FormState {
  selectedTaskName: string;
  checkedModels: Set<string>;
  extraModels: string[];
  conditionKind: ConditionSpec["kind"];
  n: number;
  should_grade: boolean;
}

export type BuildResult =
  | { ok: true; spec: RunSpec }
  | { ok: false; error: string };

export interface SelectedTaskResolution {
  task: TaskSummary | null;
  error: string | null;
}

export function selectedTaskLoadError(
  tasks: readonly TaskSummary[],
  selectedTaskName: string | null,
  taskError: string | null,
): string | null {
  if (taskError !== null) return taskError;
  if (selectedTaskName === null) return null;
  if (tasks.length === 0) return null;
  return resolveSelectedTask(tasks, selectedTaskName).error;
}

// Form models appear in catalog order; extras are appended in add order.
export function buildRunSpec(state: FormState): BuildResult {
  const modelPool = [
    ...FORM_MODELS.filter((m) => state.checkedModels.has(m.id)).map((m) => m.id),
    ...state.extraModels,
  ];
  const result = RunSpecSchema.safeParse({
    task: state.selectedTaskName,
    model_pool: modelPool,
    condition: { kind: state.conditionKind, n: state.n },
    grade: state.should_grade,
  });
  if (result.success) return { ok: true, spec: result.data };
  return {
    ok: false,
    error: result.error.issues[0]?.message ?? "invalid spec",
  };
}

export function minNFor(kind: ConditionSpec["kind"]): number {
  return kind === "ensemble_single_round" || kind === "ensemble_multi_round"
    ? 2
    : 1;
}

export function createInitialFormState(task: TaskSummary | null): FormState {
  return {
    selectedTaskName: task?.name ?? "",
    checkedModels: new Set(),
    extraModels: [],
    conditionKind: "single_agent",
    n: 1,
    should_grade: task?.has_grader ?? false,
  };
}

export function coerceFormStateForSelectedTask(
  state: FormState,
  task: TaskSummary | null,
): FormState {
  return {
    ...state,
    selectedTaskName: task?.name ?? state.selectedTaskName,
    should_grade: task?.has_grader ? state.should_grade : false,
  };
}

export function resolveSelectedTask(
  tasks: readonly TaskSummary[],
  selectedTaskName: string,
): SelectedTaskResolution {
  const task = tasks.find((entry) => entry.name === selectedTaskName) ?? null;
  if (task === null) {
    return {
      task: null,
      error:
        tasks.length === 0
          ? "task list is empty"
          : `unknown task ${selectedTaskName}`,
    };
  }
  return { task, error: null };
}

export function formatTaskSource(task: TaskSummary): string {
  return task.source === "builtin" ? "built-in" : "local";
}

export function formatTaskGraderState(task: TaskSummary): string {
  if (!task.has_grader) return "no grader";
  return task.grader_key === null ? "grader unavailable" : task.grader_key;
}
