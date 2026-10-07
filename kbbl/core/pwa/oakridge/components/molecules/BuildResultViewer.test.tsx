// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { BuildBrief } from "../../lib/build-brief";
import type { BuildResult } from "../../lib/build-result";
import type { CohortId, RepositoryKey } from "../../types";
import { BuildResultViewer } from "./BuildResultViewer";

const result: BuildResult = {
  repository_key: "assay" as RepositoryKey,
  summary: "Built the API.",
  changed_files: ["src/api.py", "ci.yml"],
  tests: { passed: 78, failed: 0, output: "78 passed", summary: null, cargo_test_output: null },
  delegated_session_metadata: { cohort_id: "cm-api", session_id: null, branch: null },
  known_issues: [{ severity: "blocking", description: "Fixture table incomplete." }],
};

const brief: BuildBrief = {
  cohort_id: "cm-api" as CohortId,
  repository_key: "assay" as RepositoryKey,
  title: "Assemble the API",
  depends_on: [],
  goal: "Build analyze().",
  files_in_scope: ["src/api.py", "src/errors.py"],
  decisions_made: [],
  approaches_rejected: [],
  acceptance_criteria: ["The golden fixture matches."],
  next_action: "Start.",
};

afterEach(cleanup);

describe("BuildResultViewer", () => {
  test("titles the result with its brief", () => {
    render(<BuildResultViewer result={result} brief={{ kind: "found", value: brief }} cohortLabel="cm-api" />);
    expect(screen.getByRole("heading", { name: "Assemble the API" })).toBeTruthy();
  });

  test("flags a change the brief did not plan", () => {
    render(<BuildResultViewer result={result} brief={{ kind: "found", value: brief }} cohortLabel="cm-api" />);
    expect(within(screen.getByTestId("or-build-files-out-of-scope")).getByText("ci.yml")).toBeTruthy();
  });

  test("lists the brief's acceptance criteria", () => {
    render(<BuildResultViewer result={result} brief={{ kind: "found", value: brief }} cohortLabel="cm-api" />);
    expect(within(screen.getByTestId("or-build-acceptance")).getByText("The golden fixture matches.")).toBeTruthy();
  });

  test("raises a blocking issue as an alert", () => {
    render(<BuildResultViewer result={result} brief={{ kind: "found", value: brief }} cohortLabel="cm-api" />);
    expect(screen.getByRole("alert").textContent).toContain("Fixture table incomplete.");
  });

  test("still lists changed files when the brief is missing", () => {
    render(<BuildResultViewer result={result} brief={{ kind: "missing", cohort_label: "cm-api" }} cohortLabel="cm-api" />);
    expect([screen.getByTestId("or-build-brief-note").textContent?.includes("cm-api"), !!screen.queryByText("ci.yml")]).toEqual([true, true]);
  });
});
