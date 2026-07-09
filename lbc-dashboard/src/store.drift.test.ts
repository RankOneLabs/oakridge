/**
 * Regression guard for the generated task catalog.
 *
 * These tests freeze the shape and key content of the generated artifact so
 * that TypeScript compile errors or unexpected registry changes surface here
 * before reaching production.
 *
 * To regenerate the artifact after a registry change:
 *   cd legit-biz-club && uv run python scripts/generate_dashboard_metadata.py
 *   git diff --exit-code ../lbc-dashboard/src/generated/task_catalog.ts
 */
import { describe, expect, test } from "bun:test";

import {
  BUILTIN_GRADER_SUMMARIES,
  BUILTIN_TASK_DETAILS,
} from "./generated/task_catalog";

describe("BUILTIN_TASK_DETAILS", () => {
  test("has exactly 5 builtin tasks", () => {
    expect(BUILTIN_TASK_DETAILS.length).toBe(5);
  });

  test("all tasks are marked as builtin source", () => {
    for (const task of BUILTIN_TASK_DETAILS) {
      expect(task.source).toBe("builtin");
    }
  });

  test("contains all expected task names", () => {
    const names = BUILTIN_TASK_DETAILS.map((t) => t.name);
    expect(names).toContain("prose_substrate_thesis");
    expect(names).toContain("code_leetcode_longest_substring");
    expect(names).toContain("code_leetcode_trapping_rain_water");
    expect(names).toContain("code_leetcode_regex_matching");
    expect(names).toContain("code_leetcode_median_two_sorted_arrays");
  });

  test("prose_substrate_thesis has correct metadata", () => {
    const task = BUILTIN_TASK_DETAILS.find(
      (t) => t.name === "prose_substrate_thesis",
    )!;
    expect(task.artifact_type).toBe("prose");
    expect(task.artifact_filename).toBe("thesis.md");
    expect(task.has_grader).toBe(true);
    expect(task.grader_key).toBe("prose_substrate_thesis");
    expect(task.model_pool.length).toBeGreaterThan(0);
    expect(task.brief.success_criteria.length).toBeGreaterThan(0);
    expect(task.brief.constraints.length).toBeGreaterThan(0);
  });

  test("code tasks have .py artifact filenames", () => {
    for (const task of BUILTIN_TASK_DETAILS) {
      if (task.artifact_type === "code") {
        expect(task.artifact_filename).toMatch(/\.py$/);
      }
    }
  });

  test("all tasks with graders have matching grader keys", () => {
    for (const task of BUILTIN_TASK_DETAILS) {
      if (task.has_grader) {
        expect(typeof task.grader_key).toBe("string");
        expect(task.grader_key).not.toBeNull();
      } else {
        expect(task.grader_key).toBeNull();
      }
    }
  });

  test("all tasks have non-empty model_pool", () => {
    for (const task of BUILTIN_TASK_DETAILS) {
      expect(task.model_pool.length).toBeGreaterThan(0);
    }
  });
});

describe("BUILTIN_GRADER_SUMMARIES", () => {
  test("has exactly 5 builtin graders", () => {
    expect(BUILTIN_GRADER_SUMMARIES.length).toBe(5);
  });

  test("all graders are marked as builtin source", () => {
    for (const grader of BUILTIN_GRADER_SUMMARIES) {
      expect(grader.source).toBe("builtin");
    }
  });

  test("contains prose grader with llm-judge capability", () => {
    const prose = BUILTIN_GRADER_SUMMARIES.find(
      (g) => g.key === "prose_substrate_thesis",
    )!;
    expect(prose.label).toBeTruthy();
    expect(prose.supported_artifact_types).toContain("prose");
    expect(prose.capabilities).toContain("llm-judge");
  });

  test("all code graders have pytest and mypy capabilities", () => {
    for (const grader of BUILTIN_GRADER_SUMMARIES) {
      if (grader.supported_artifact_types.includes("code")) {
        expect(grader.capabilities).toContain("pytest");
        expect(grader.capabilities).toContain("mypy");
      }
    }
  });

  test("median grader has perf capability", () => {
    const median = BUILTIN_GRADER_SUMMARIES.find(
      (g) => g.key === "code_leetcode_median_two_sorted_arrays",
    )!;
    expect(median.capabilities).toContain("perf");
  });

  test("grader keys match task keys one-to-one", () => {
    const taskNames = new Set(BUILTIN_TASK_DETAILS.map((t) => t.name));
    for (const grader of BUILTIN_GRADER_SUMMARIES) {
      expect(taskNames.has(grader.key)).toBe(true);
    }
  });
});
