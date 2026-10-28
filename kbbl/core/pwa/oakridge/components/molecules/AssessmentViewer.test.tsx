// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Assessment } from "../../lib/assessment";
import type { BuildBrief } from "../../lib/build-brief";
import type { BuildResult } from "../../lib/build-result";
import type { CohortId, RepositoryKey } from "../../types";
import { parseAssessment } from "../../lib/assessment";
import { readBuildBrief } from "../../lib/build-brief";
import linkedAssessment from "../../lib/__fixtures__/id-linked-assessment.json";
import emptyEvidenceAssessment from "../../lib/__fixtures__/empty-evidence-assessment.json";
import unresolvedAssessment from "../../lib/__fixtures__/unresolved-assessment.json";
import linkedBrief from "../../lib/__fixtures__/id-linked-brief.json";
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
  head_sha: null,
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
    { criterion_id: null, criterion: "The CLI prints JSON.", status: "met", evidence: { kind: "legacy", text: "Snapshot test passes." }, description: null },
    { criterion_id: null, criterion: "Every fixture exists.", status: "not_met", evidence: { kind: "legacy", text: "B, E, F and G are missing." }, description: null },
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

  test("labels a legacy assessment commit as not recorded", () => {
    renderViewer();
    expect(screen.getByTestId("or-assessment-head-sha").textContent).toContain("Not recorded");
    expect(within(screen.getByTestId("or-assessment-attention")).getByText("Matched by normalized text")).toBeTruthy();
  });

  test("shows linked evidence references and their matching provenance", () => {
    const parsed = parseAssessment(linkedAssessment);
    const linked = readBuildBrief(linkedBrief);
    if (!parsed.ok || linked === null) throw new Error("fixture failed to parse");
    render(<AssessmentViewer assessment={parsed.value} brief={{ kind: "found", value: linked }} result={{ kind: "loading" }} cohortLabel="pwa" />);
    fireEvent.click(screen.getByRole("button", { name: /Show met criteria/ }));
    expect(screen.getByTestId("or-assessment-head-sha").textContent).toContain("abc123def456");
    const met = within(screen.getByTestId("or-assessment-met"));
    expect(met.getByText("Matched by criterion ID")).toBeTruthy();
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

  test("shows an unresolved criterion id", () => {
    const parsed = parseAssessment(unresolvedAssessment);
    const linked = readBuildBrief(linkedBrief);
    if (!parsed.ok || linked === null) throw new Error("fixture failed to parse");
    render(<AssessmentViewer assessment={parsed.value} brief={{ kind: "found", value: linked }} result={{ kind: "loading" }} cohortLabel="pwa" />);
    expect(screen.getByText("criterion-missing")).toBeTruthy();
    expect(screen.getByText("No brief criterion match")).toBeTruthy();
  });

  test("does not call an unassessed brief criterion unmatched to the brief", () => {
    render(<AssessmentViewer assessment={{ ...assessment, findings: assessment.findings.slice(0, 1) }} brief={{ kind: "found", value: brief }} result={{ kind: "loading" }} cohortLabel="cm-cli" />);
    const attention = within(screen.getByTestId("or-assessment-attention"));
    expect(attention.getByText("Every fixture exists.")).toBeTruthy();
    expect(attention.queryByText("No brief criterion match")).toBeNull();
  });

  test("still lists findings when the brief is missing", () => {
    render(<AssessmentViewer assessment={assessment} brief={{ kind: "missing", cohort_label: "cm-cli" }} result={{ kind: "loading" }} cohortLabel="cm-cli" />);
    expect(within(screen.getByTestId("or-assessment-attention")).getByText("Every fixture exists.")).toBeTruthy();
    expect(screen.queryByText("No brief criterion match")).toBeNull();
  });

  test("keeps the derived needs-attention criteria read-only", () => {
    renderViewer();
    const attention = within(screen.getByTestId("or-assessment-attention"));
    expect(attention.queryByRole("checkbox")).toBeNull();
    expect(attention.queryByRole("button", { name: /Edit/ })).toBeNull();
  });

  test("renders an integration assessment without cohort artifact warnings", () => {
    render(<AssessmentViewer assessment={assessment} brief={{ kind: "missing", cohort_label: null }}
      result={{ kind: "missing", cohort_label: null }} cohortLabel="assay" isIntegration />);
    expect(screen.getByText("Integration assessment")).toBeTruthy();
    expect(screen.queryByTestId("or-assessment-brief-note")).toBeNull();
    expect(screen.queryByTestId("or-assessment-result-note")).toBeNull();
    expect(screen.queryByText("Not one of the brief's criteria.")).toBeNull();
    expect(screen.queryByText("No brief criterion match")).toBeNull();
    expect(within(screen.getByTestId("or-assessment-attention")).getByText("Every fixture exists.")).toBeTruthy();
  });
});
