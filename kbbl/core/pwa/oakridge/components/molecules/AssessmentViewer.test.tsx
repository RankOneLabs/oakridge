// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { LegacyAssessment as Assessment } from "../../lib/assessment";
import type { BuildBrief } from "../../lib/build-brief";
import type { BuildResult } from "../../lib/build-result";
import type { PlanTraceId } from "../../lib/plan";
import type { CohortId, RepositoryKey } from "../../run-types";
import { parseAssessment } from "../../lib/assessment";
import { readBuildBrief } from "../../lib/build-brief";
import linkedAssessment from "../../lib/__fixtures__/id-linked-assessment.json";
import emptyEvidenceAssessment from "../../lib/__fixtures__/empty-evidence-assessment.json";
import unresolvedAssessment from "../../lib/__fixtures__/unresolved-assessment.json";
import linkedBrief from "../../lib/__fixtures__/id-linked-brief.json";
import { AssessmentViewer } from "./AssessmentViewer";

const task = (id: string): PlanTraceId => id as PlanTraceId;

const brief: BuildBrief = {
  shape: "legacy",
  cohort_id: "cm-cli" as CohortId,
  repository_key: "assay" as RepositoryKey,
  title: "The CLI",
  depends_on: [],
  goal: "Ship the CLI.",
  files_in_scope: [],
  decisions_made: [],
  approaches_rejected: [],
  acceptance_criteria: [
    { id: task("T1"), text: "The CLI prints JSON.", decision_ids: [] },
    { id: task("T2"), text: "Every fixture exists.", decision_ids: [] },
  ],
  next_action: "Start.",
};

const result: BuildResult = {
  head_sha: null,
  repository_key: "assay" as RepositoryKey,
  summary: "Built it.",
  changed_files: [],
  tests: { passed: 1409, failed: 0, output: null, summary: null, cargo_test_output: null },
  delegated_session_metadata: null,
  known_issues: [],
};

const assessment: Assessment = {
  head_sha: "abc123",
  verdict: "fail",
  findings: [
    { item_path: "/findings/0", task_ids: [task("T1")], status: "met", evidence: [{ kind: "test", ref: "test_cli.py::snapshot", detail: "Snapshot test passes." }], description: null },
    { item_path: "/findings/1", task_ids: [task("T2")], status: "not_met", evidence: [{ kind: "output", ref: "ls fixtures", detail: "B, E, F and G are missing." }], description: null },
  ],
  test_evidence: { passed: 1274, failed: 0, output: null, summary: "Independently re-run.", cargo_test_output: null },
  recommended_next_actions: [{ id: "00000000-0000-4000-8000-000000000001", text: "Supply the missing fixtures." }],
};

const renderViewer = () => render(
  <AssessmentViewer assessment={assessment} brief={{ kind: "found", value: brief }} result={{ kind: "found", value: result }} cohortLabel="cm-cli" />,
);

const renderFindings = (findings: Assessment["findings"]) => render(
  <AssessmentViewer assessment={{ ...assessment, findings }} brief={{ kind: "found", value: brief }} result={{ kind: "loading" }} cohortLabel="cm-cli" />,
);

const attention = () => within(screen.getByTestId("or-assessment-attention"));

afterEach(cleanup);

describe("AssessmentViewer", () => {
  test("names a finding's task with the brief's number", () => {
    renderViewer();
    expect(attention().getByTestId("or-criterion-tasks").textContent).toBe("Tasks: T2 (2)");
  });

  test("reads a finding with no description by the wording of its task", () => {
    renderViewer();
    expect(attention().getByText("Every fixture exists.")).toBeTruthy();
  });

  test("marks each line with its status and kind", () => {
    renderViewer();
    const check = attention().getByTestId("or-criterion-check");
    expect([check.getAttribute("data-status"), check.getAttribute("data-kind")]).toEqual(["not_met", "finding"]);
  });

  test("keeps met findings folded until asked", () => {
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

  test("shows the commit the assessment assessed", () => {
    renderViewer();
    expect(screen.getByTestId("or-assessment-head-sha").textContent).toContain("abc123");
  });

  test("shows evidence references, their kinds and the linked task", () => {
    const parsed = parseAssessment(linkedAssessment);
    const linked = readBuildBrief(linkedBrief);
    if (!parsed.ok || linked === null) throw new Error("fixture failed to parse");
    render(<AssessmentViewer assessment={parsed.value} brief={{ kind: "found", value: linked }} result={{ kind: "loading" }} cohortLabel="pwa" />);
    fireEvent.click(screen.getByRole("button", { name: /Show met criteria/ }));
    expect(screen.getByTestId("or-assessment-head-sha").textContent).toContain("abc123def456");
    const met = within(screen.getByTestId("or-assessment-met"));
    expect(met.getByTestId("or-criterion-tasks").textContent).toBe("Tasks: criterion-brief (1)");
    expect(met.getByText("file")).toBeTruthy();
    expect(met.getByText("kbbl/core/pwa/oakridge/lib/build-brief.ts:100-110")).toBeTruthy();
    expect(met.getByText("test")).toBeTruthy();
    expect(met.getByText("output")).toBeTruthy();
  });

  test("marks a met finding with an empty evidence list", () => {
    const parsed = parseAssessment(emptyEvidenceAssessment);
    if (!parsed.ok) throw new Error("fixture failed to parse");
    render(<AssessmentViewer assessment={parsed.value} brief={{ kind: "missing", cohort_label: "pwa" }} result={{ kind: "loading" }} cohortLabel="pwa" />);
    fireEvent.click(screen.getByRole("button", { name: /Show met criteria/ }));
    expect(screen.getByText("Met with no evidence cited.")).toBeTruthy();
  });

  test("shows a task id the brief does not hold as unresolved", () => {
    const parsed = parseAssessment(unresolvedAssessment);
    const linked = readBuildBrief(linkedBrief);
    if (!parsed.ok || linked === null) throw new Error("fixture failed to parse");
    render(<AssessmentViewer assessment={parsed.value} brief={{ kind: "found", value: linked }} result={{ kind: "loading" }} cohortLabel="pwa" />);
    expect(screen.getByTestId("or-criterion-unresolved").textContent).toBe("Unresolved task IDs: criterion-missing");
  });

  test("shows every task of a finding linked to several as one line", () => {
    renderFindings([{ ...assessment.findings[0]!, task_ids: [task("T1"), task("T2")] }]);
    fireEvent.click(screen.getByRole("button", { name: /Show met criteria/ }));
    expect(within(screen.getByTestId("or-assessment-met")).getAllByTestId("or-criterion-check")).toHaveLength(1);
    expect(screen.getByTestId("or-criterion-tasks").textContent).toBe("Tasks: T1 (1)T2 (2)");
  });

  test("says when a finding is linked to no task", () => {
    renderFindings([{ ...assessment.findings[1]!, task_ids: [], description: "A gap nobody planned." }]);
    expect(attention().getByText("Linked to no task.")).toBeTruthy();
  });

  test("lists a brief task no finding names as unassessed, numbered as the brief does", () => {
    renderFindings(assessment.findings.slice(0, 1));
    const check = attention().getByTestId("or-criterion-check");
    expect([check.getAttribute("data-status"), check.getAttribute("data-kind")]).toEqual(["unassessed", "unassessed"]);
    expect(within(check).getByText("2.")).toBeTruthy();
    expect(within(check).getByText("Every fixture exists.")).toBeTruthy();
    expect(screen.queryByTestId("or-criterion-unresolved")).toBeNull();
  });

  test("still lists findings when the brief is missing, without judging their links", () => {
    render(<AssessmentViewer assessment={assessment} brief={{ kind: "missing", cohort_label: "cm-cli" }} result={{ kind: "loading" }} cohortLabel="cm-cli" />);
    expect(attention().getByText("B, E, F and G are missing.")).toBeTruthy();
    expect(screen.queryByTestId("or-criterion-unresolved")).toBeNull();
  });

  test("keeps the derived needs-attention findings read-only", () => {
    renderViewer();
    expect(attention().queryByRole("checkbox")).toBeNull();
    expect(attention().queryByRole("button", { name: /Edit/ })).toBeNull();
  });

  test("renders an integration assessment without cohort artifact warnings", () => {
    render(<AssessmentViewer assessment={assessment} brief={{ kind: "missing", cohort_label: null }}
      result={{ kind: "missing", cohort_label: null }} cohortLabel="assay" isIntegration />);
    expect(screen.getByText("Integration assessment")).toBeTruthy();
    expect(screen.queryByTestId("or-assessment-brief-note")).toBeNull();
    expect(screen.queryByTestId("or-assessment-result-note")).toBeNull();
    expect(screen.queryByTestId("or-criterion-unresolved")).toBeNull();
    expect(attention().getByText("B, E, F and G are missing.")).toBeTruthy();
  });

  test("does not ask an integration finding to link to a task", () => {
    render(<AssessmentViewer assessment={{ ...assessment, findings: [{ ...assessment.findings[1]!, task_ids: [] }] }} brief={{ kind: "missing", cohort_label: null }}
      result={{ kind: "missing", cohort_label: null }} cohortLabel="assay" isIntegration />);
    expect(screen.queryByText("Linked to no task.")).toBeNull();
  });
});
