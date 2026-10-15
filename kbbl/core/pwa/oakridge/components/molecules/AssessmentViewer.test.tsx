// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Assessment } from "../../lib/assessment";
import type { BuildBrief } from "../../lib/build-brief";
import type { BuildResult } from "../../lib/build-result";
import type { CohortId, RepositoryKey } from "../../types";
import { AssessmentViewer } from "./AssessmentViewer";

const brief: BuildBrief = {
  cohort_id: "cm-cli" as CohortId,
  repository_key: "assay" as RepositoryKey,
  title: "The CLI",
  depends_on: [],
  goal: "Ship the CLI.",
  files_in_scope: [],
  decisions_made: [],
  approaches_rejected: [],
  acceptance_criteria: ["The CLI prints JSON.", "Every fixture exists."],
  next_action: "Start.",
};

const result: BuildResult = {
  repository_key: "assay" as RepositoryKey,
  summary: "Built it.",
  changed_files: [],
  tests: { passed: 1409, failed: 0, output: null, summary: null, cargo_test_output: null },
  delegated_session_metadata: null,
  known_issues: [],
};

const assessment: Assessment = {
  verdict: "fail",
  findings: [
    { criterion: "The CLI prints JSON.", status: "met", evidence: "Snapshot test passes.", description: null },
    { criterion: "Every fixture exists.", status: "not_met", evidence: "B, E, F and G are missing.", description: null },
  ],
  test_evidence: { passed: 1274, failed: 0, output: null, summary: "Independently re-run.", cargo_test_output: null },
  recommended_next_actions: ["Supply the missing fixtures."],
};

const renderViewer = () => render(
  <AssessmentViewer assessment={assessment} brief={{ kind: "found", value: brief }} result={{ kind: "found", value: result }} cohortLabel="cm-cli" />,
);

afterEach(cleanup);

describe("AssessmentViewer", () => {
  test("numbers an unmet criterion as the brief does", () => {
    renderViewer();
    const attention = within(screen.getByTestId("or-assessment-attention"));
    expect(attention.getByText("2.")).toBeTruthy();
  });

  test("keeps met criteria folded until asked", () => {
    renderViewer();
    expect(screen.queryByText("Snapshot test passes.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show met criteria/ }));
    expect(screen.getByText("Snapshot test passes.")).toBeTruthy();
  });

  test("sets the builder's reported tests beside the assessor's run", () => {
    renderViewer();
    expect(screen.getByTestId("or-assessment-builder-tests").textContent).toContain("1409 passed");
  });

  test("shows the verdict", () => {
    renderViewer();
    expect(screen.getByTestId("or-assessment-verdict").textContent).toBe("Fail");
  });

  test("still lists findings when the brief is missing", () => {
    render(<AssessmentViewer assessment={assessment} brief={{ kind: "missing", cohort_label: "cm-cli" }} result={{ kind: "loading" }} cohortLabel="cm-cli" />);
    expect(within(screen.getByTestId("or-assessment-attention")).getByText("Every fixture exists.")).toBeTruthy();
  });
});
