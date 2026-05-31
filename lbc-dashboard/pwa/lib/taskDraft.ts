import type { TaskDraft } from "../../src/contracts";

export const TASK_DRAFT_STORAGE_KEY = "lbc-dashboard.task-draft.v1";

export const DEFAULT_MODEL_POOLS: Record<
  TaskDraft["artifact_type"],
  string[]
> = {
  prose: [
    "claude-sonnet-4-5",
    "gpt-5-mini",
    "gemini-2.5-pro",
    "claude-opus-4-7",
    "gpt-5",
    "gemini-2.5-flash",
    "claude-haiku-4-5",
  ],
  code: [
    "claude-sonnet-4-5",
    "gpt-5",
    "claude-opus-4-7",
    "gemini-2.5-pro",
    "gpt-5-mini",
    "claude-haiku-4-5",
    "gemini-2.5-flash",
  ],
};

export const DEFAULT_FRAME_POOLS: Record<
  TaskDraft["artifact_type"],
  string[]
> = {
  prose: [
    "precision",
    "skepticism",
    "synthesis",
    "user-empathy",
    "first-principles",
    "concision",
    "voice",
  ],
  code: [
    "type-safety",
    "test-coverage",
    "minimalism",
    "defensive-programming",
    "performance",
    "readability",
    "explicit-errors",
  ],
};

export interface TaskDraftFormState {
  name: string;
  artifact_type: TaskDraft["artifact_type"];
  artifact_filename: string;
  seed_content: string;
  brief: TaskDraft["brief"];
  model_pool: string[];
  frame_pool: string[];
  grader: TaskDraft["grader"];
}

export function blankTaskDraftForm(
  artifact_type: TaskDraft["artifact_type"] = "prose",
): TaskDraftFormState {
  return {
    name: "",
    artifact_type,
    artifact_filename: artifact_type === "code" ? "solution.py" : "draft.md",
    seed_content: "",
    brief: {
      target_spec: "",
      success_criteria: [],
      constraints: [],
    },
    model_pool: [],
    frame_pool: [],
    grader: { kind: "none" },
  };
}

export function parseLineList(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function formatLineList(values: string[]): string {
  return values.join("\n");
}

export function taskDraftFormToPayload(
  form: TaskDraftFormState,
): TaskDraft | { error: string } {
  const model_pool =
    form.model_pool.length > 0
      ? form.model_pool
      : DEFAULT_MODEL_POOLS[form.artifact_type];
  const frame_pool =
    form.frame_pool.length > 0
      ? form.frame_pool
      : DEFAULT_FRAME_POOLS[form.artifact_type];
  if (form.brief.target_spec.trim() === "") {
    return { error: "target_spec is required" };
  }
  if (form.brief.success_criteria.length === 0) {
    return { error: "success_criteria is required" };
  }
  const payload: TaskDraft = {
    name: form.name.trim(),
    artifact_type: form.artifact_type,
    artifact_filename: form.artifact_filename.trim(),
    seed_content: form.seed_content,
    brief: {
      target_spec: form.brief.target_spec.trim(),
      success_criteria: form.brief.success_criteria,
      constraints: form.brief.constraints,
    },
    model_pool,
    frame_pool,
    grader: form.grader,
  };
  return payload;
}

export function sanitizeTaskDraftForm(
  draft: TaskDraftFormState,
): TaskDraftFormState {
  return {
    ...draft,
    name: draft.name.trim(),
    artifact_filename: draft.artifact_filename.trim(),
    brief: {
      target_spec: draft.brief.target_spec.trim(),
      success_criteria: draft.brief.success_criteria
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      constraints: draft.brief.constraints
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    },
    model_pool: draft.model_pool.map((entry) => entry.trim()).filter(Boolean),
    frame_pool: draft.frame_pool.map((entry) => entry.trim()).filter(Boolean),
  };
}

export function isBlankTaskDraftForm(form: TaskDraftFormState): boolean {
  const defaultFilename =
    form.artifact_type === "code" ? "solution.py" : "draft.md";
  return (
    form.name.trim() === "" &&
    form.artifact_filename.trim() === defaultFilename &&
    form.seed_content === "" &&
    form.brief.target_spec.trim() === "" &&
    form.brief.success_criteria.length === 0 &&
    form.brief.constraints.length === 0 &&
    form.model_pool.length === 0 &&
    form.frame_pool.length === 0 &&
    form.grader.kind === "none"
  );
}

export function loadTaskDraftForm(
  raw: string | null,
): TaskDraftFormState | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const obj = parsed as Partial<TaskDraftFormState>;
    if (
      typeof obj.name !== "string" ||
      typeof obj.artifact_type !== "string" ||
      typeof obj.artifact_filename !== "string" ||
      typeof obj.seed_content !== "string" ||
      typeof obj.brief !== "object" ||
      obj.brief === null ||
      typeof obj.grader !== "object" ||
      obj.grader === null
    ) {
      return null;
    }
    const brief = obj.brief as Partial<TaskDraft["brief"]>;
    const grader = obj.grader as TaskDraft["grader"];
    const graderRef: TaskDraft["grader"] =
      grader.kind === "registered" && typeof grader.key === "string"
        ? { kind: "registered", key: grader.key }
        : { kind: "none" };
    return sanitizeTaskDraftForm({
      name: obj.name,
      artifact_type:
        obj.artifact_type === "code" ? "code" : "prose",
      artifact_filename: obj.artifact_filename,
      seed_content: obj.seed_content,
      brief: {
        target_spec:
          typeof brief.target_spec === "string" ? brief.target_spec : "",
        success_criteria: Array.isArray(brief.success_criteria)
          ? brief.success_criteria.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
        constraints: Array.isArray(brief.constraints)
          ? brief.constraints.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
      },
      model_pool: Array.isArray(obj.model_pool)
        ? obj.model_pool.filter((entry): entry is string => typeof entry === "string")
        : [],
      frame_pool: Array.isArray(obj.frame_pool)
        ? obj.frame_pool.filter((entry): entry is string => typeof entry === "string")
        : [],
      grader: graderRef,
    });
  } catch {
    return null;
  }
}
