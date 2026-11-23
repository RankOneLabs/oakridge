import { describe, expect, test } from "vitest";
import {
  selectFileScopeComparison,
  selectOrderedIssues,
  selectTestEvidenceText,
} from "./build-result";

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
