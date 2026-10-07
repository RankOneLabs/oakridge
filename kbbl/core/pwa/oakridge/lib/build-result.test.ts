import { describe, expect, test } from "vitest";
import {
  parseBuildResult,
  selectFileScopeComparison,
  selectOrderedIssues,
  selectTestEvidenceText,
} from "./build-result";

const body = {
  repository_key: "assay",
  summary: "Built the API.",
  changed_files: ["src/api.py"],
  tests: { passed: 78, failed: 0, output: "78 passed" },
  delegated_session_metadata: { cohort_id: "cm-api" },
  known_issues: [{ severity: "info", description: "Slow fixture." }],
};

describe("parseBuildResult", () => {
  test("reads omitted test text and metadata fields as null", () => {
    const result = parseBuildResult(body);
    expect(result.ok && [result.value.tests.summary, result.value.delegated_session_metadata?.branch]).toEqual([null, null]);
  });

  test("names an issue whose severity is outside the contract", () => {
    const result = parseBuildResult({ ...body, known_issues: [{ severity: "critical", description: "x" }] });
    expect(result.ok ? null : result.error.field).toBe("known_issues[0]");
  });

  test("rejects test evidence without counts", () => {
    expect(parseBuildResult({ ...body, tests: { output: "ran" } }).ok).toBe(false);
  });
});

describe("selectFileScopeComparison", () => {
  const comparison = selectFileScopeComparison(["src/api.py", "src/errors.py", "docs/"], ["src/api.py", "docs/guide.md", "ci.yml"]);

  test("counts a file under a planned directory as in scope", () => {
    expect(comparison.changed_in_scope).toEqual(["src/api.py", "docs/guide.md"]);
  });

  test("flags a changed file the brief never named", () => {
    expect(comparison.changed_out_of_scope).toEqual(["ci.yml"]);
  });

  test("lists planned files the build left alone", () => {
    expect(comparison.planned_untouched).toEqual(["src/errors.py"]);
  });
});

describe("issue and evidence selectors", () => {
  test("orders issues blocking first", () => {
    const ordered = selectOrderedIssues([
      { severity: "info", description: "a" },
      { severity: "blocking", description: "b" },
      { severity: "warning", description: "c" },
    ]);
    expect(ordered.map((issue) => issue.description)).toEqual(["b", "c", "a"]);
  });

  test("skips blank evidence text", () => {
    expect(selectTestEvidenceText({ passed: 1, failed: 0, output: "ok", summary: " ", cargo_test_output: null })).toEqual(["ok"]);
  });
});
