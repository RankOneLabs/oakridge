/**
 * Unit tests for the buildRunSpec pure helper and related launch-form
 * selectors. The form UI is verified manually via `bun run dev:pwa`.
 */
import { describe, expect, test } from "bun:test";

import {
  buildRunSpec,
  coerceFormStateForSelectedTask,
  createInitialFormState,
  formatTaskGraderState,
  formatTaskSource,
  resolveSelectedTask,
  selectedTaskLoadError,
  type FormState,
} from "./components/organisms/launchFormModel";

const BUILTIN_TASK = {
  name: "prose_substrate_thesis",
  artifact_type: "prose" as const,
  artifact_filename: "thesis.md",
  has_grader: true,
  grader_key: "prose_substrate_thesis",
  source: "builtin" as const,
};

const LOCAL_UNGRADED_TASK = {
  name: "dashboard_local_task",
  artifact_type: "prose" as const,
  artifact_filename: "draft.md",
  has_grader: false,
  grader_key: null,
  source: "local" as const,
};

const base: FormState = {
  selectedTaskName: "prose_substrate_thesis",
  checkedModels: new Set(["claude-sonnet-4-5"]),
  extraModels: [],
  conditionKind: "single_agent",
  n: 1,
  should_grade: true,
};

describe("buildRunSpec", () => {
  test("accepts valid single_agent spec", () => {
    const r = buildRunSpec(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.condition.kind).toBe("single_agent");
      expect(r.spec.model_pool).toEqual(["claude-sonnet-4-5"]);
      expect(r.spec.grade).toBe(true);
    }
  });

  test("rejects empty model_pool", () => {
    const r = buildRunSpec({ ...base, checkedModels: new Set(), extraModels: [] });
    expect(r.ok).toBe(false);
  });

  test("rejects ensemble_multi_round with n=1", () => {
    const r = buildRunSpec({ ...base, conditionKind: "ensemble_multi_round", n: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/n >= 2/);
    }
  });

  test("accepts ensemble_multi_round with n=2", () => {
    const r = buildRunSpec({ ...base, conditionKind: "ensemble_multi_round", n: 2 });
    expect(r.ok).toBe(true);
  });

  test("accepts ensemble_single_round with n=3", () => {
    const r = buildRunSpec({ ...base, conditionKind: "ensemble_single_round", n: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.condition.n).toBe(3);
    }
  });

  test("rejects ensemble_single_round with n=1", () => {
    const r = buildRunSpec({ ...base, conditionKind: "ensemble_single_round", n: 1 });
    expect(r.ok).toBe(false);
  });

  test("accepts ensemble_incremental with n=1", () => {
    const r = buildRunSpec({ ...base, conditionKind: "ensemble_incremental", n: 1 });
    expect(r.ok).toBe(true);
  });

  test("includes extra models after known models in pool", () => {
    const r = buildRunSpec({
      ...base,
      checkedModels: new Set(["claude-sonnet-4-5"]),
      extraModels: ["openrouter/my-custom-model"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.model_pool).toEqual([
        "claude-sonnet-4-5",
        "openrouter/my-custom-model",
      ]);
    }
  });

  test("known models appear in catalog order regardless of check order", () => {
    const r = buildRunSpec({
      ...base,
      checkedModels: new Set(["gpt-5", "claude-haiku-4-5"]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.model_pool).toEqual(["claude-haiku-4-5", "gpt-5"]);
    }
  });

  test("includes opus 4.8 as a known model", () => {
    const r = buildRunSpec({
      ...base,
      checkedModels: new Set(["claude-opus-4-8"]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.model_pool).toEqual(["claude-opus-4-8"]);
    }
  });

  test("accepts arbitrary task names", () => {
    const r = buildRunSpec({
      ...base,
      selectedTaskName: "dashboard_local_task",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.task).toBe("dashboard_local_task");
    }
  });

  test("rejects single_agent with n=2", () => {
    const r = buildRunSpec({ ...base, conditionKind: "single_agent", n: 2 });
    expect(r.ok).toBe(false);
  });

  test("initializes ungraded tasks with grade off", () => {
    const state = createInitialFormState(LOCAL_UNGRADED_TASK);
    expect(state.should_grade).toBe(false);
  });

  test("forces grade off when switching to an ungraded task", () => {
    const state = coerceFormStateForSelectedTask(
      { ...base, should_grade: true },
      LOCAL_UNGRADED_TASK,
    );
    expect(state.should_grade).toBe(false);
  });

  test("keeps grade on when switching to a graded task", () => {
    const state = coerceFormStateForSelectedTask(
      { ...base, should_grade: true },
      BUILTIN_TASK,
    );
    expect(state.should_grade).toBe(true);
  });

  test("resolves selected tasks and reports invalid selections", () => {
    const resolved = resolveSelectedTask(
      [BUILTIN_TASK, LOCAL_UNGRADED_TASK],
      "dashboard_local_task",
    );
    expect(resolved.task?.name).toBe("dashboard_local_task");
    expect(resolved.error).toBeNull();

    const missing = resolveSelectedTask([BUILTIN_TASK], "missing_task");
    expect(missing.task).toBeNull();
    expect(missing.error).toMatch(/unknown task missing_task/);
  });

  test("formats task source and grader state for the selector detail", () => {
    expect(formatTaskSource(BUILTIN_TASK)).toBe("built-in");
    expect(formatTaskSource(LOCAL_UNGRADED_TASK)).toBe("local");
    expect(formatTaskGraderState(BUILTIN_TASK)).toBe("prose_substrate_thesis");
    expect(formatTaskGraderState(LOCAL_UNGRADED_TASK)).toBe("no grader");
  });

  test("suppresses invalid selection errors until tasks have loaded", () => {
    expect(selectedTaskLoadError([], "missing_task", null)).toBeNull();
    expect(selectedTaskLoadError([BUILTIN_TASK], "missing_task", null)).toMatch(
      /unknown task missing_task/,
    );
    expect(selectedTaskLoadError([], null, "boom")).toBe("boom");
  });
});
