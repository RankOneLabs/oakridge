import { json, world, wrap, requireControl } from "./item-panel-harness";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { id, IMPLEMENTATION, INTEGRATION, ANALYSIS, itemStatus, paged, supportQuestion } from "../__fixtures__/grading";
import { compositeId } from "../adapters/core";
import { AssessmentViewer } from "../components/molecules/AssessmentViewer";
import { SpecAnalysisViewer } from "../components/molecules/SpecAnalysisViewer";
import { FinalIntegrationPanel } from "../components/organisms/FinalIntegrationPanel";
import { ItemPanel } from "../components/organisms/ItemPanel";
import { RunGradingSection } from "../components/organisms/RunGradingSection";
import type { ObservationQuestionKey } from "../grading-contracts/grading/question";
import { parseAssessment } from "../lib/assessment";
import { useGradingVisibility } from "../state/gradingVisibility";
import type { EpicWorkflowProfile } from "../run-types";

describe("every entry point opens the same item", () => {
  const revisionId = (unit: string, artifact: string, id: string) => compositeId({ kind: "artifact", runId: "run-1", unitId: unit, name: `${artifact}:${id}` });
  const body = { head_sha: "abc", verdict: "pass", test_evidence: null, recommended_next_actions: [], findings: [
    { task_ids: ["T1"], status: "met", evidence: [], description: "linked" }, { task_ids: [], status: "not_met", evidence: [], description: "unlinked" }] };
  const assessment = () => { const parsed = parseAssessment(body); if (!parsed.ok) throw new Error(parsed.error.detail); return parsed.value; };
  const missing = { kind: "missing", cohort_label: null } as const;
  it("analysis: a finding addressed by its original index even though the view reorders it", () => {
    const onOpenItem = vi.fn();
    wrap(<SpecAnalysisViewer source={{ run_id: id("run-1"), revision_id: revisionId("run-1/analysis", "analysis", ANALYSIS.source_revision_id), label: null, as_of: "t" }} onOpenItem={onOpenItem}
      body={{ summary: "s", source_spec_refs: [], requirements: [], risks: [], proposed_spec_updates: [], findings: [
        { id: "F1", description: "info one", severity: "info" }, { id: "F2", description: "blocking one", severity: "blocking" }, { id: "F3", description: "warning one", severity: "warning" }] }} />);
    const buttons = screen.getAllByTestId("or-grade-item");
    expect(buttons.map((button) => button.getAttribute("data-item-path"))).toEqual(["/findings/1", "/findings/2", "/findings/0"]);
    fireEvent.click(requireControl(buttons, 0));
    expect(onOpenItem).toHaveBeenCalledWith({ source_revision_id: ANALYSIS.source_revision_id, item_path: "/findings/1" });
  });
  it("analysis: a risk or requirement gets no grade control", () => {
    wrap(<SpecAnalysisViewer source={{ run_id: id("run-1"), revision_id: revisionId("u", "analysis", "r"), label: null, as_of: "t" }} onOpenItem={vi.fn()}
      body={{ summary: "s", source_spec_refs: [], findings: [], proposed_spec_updates: [], requirements: [{ id: "R", description: "d", status: "implementable" }], risks: [{ description: "d", mitigation: "m" }] }} />);
    expect(screen.queryByTestId("or-grade-item")).toBeNull();
  });
  it("implementation: every finding opens with no brief, cohort or link required", () => {
    const onOpenItem = vi.fn();
    wrap(<AssessmentViewer assessment={assessment()} brief={missing} result={missing} cohortLabel={null} source={{ revision_id: revisionId("run-1/implementation/one", "assessment", IMPLEMENTATION.source_revision_id) }} onOpenItem={onOpenItem} />);
    fireEvent.click(screen.getByText(/Show met criteria/));
    const buttons = screen.getAllByTestId("or-grade-item");
    expect(buttons.map((button) => button.getAttribute("data-item-path")).sort()).toEqual(["/findings/0", "/findings/1"]);
    fireEvent.click(requireControl(buttons, 0));
    expect(onOpenItem).toHaveBeenCalledWith({ source_revision_id: IMPLEMENTATION.source_revision_id, item_path: "/findings/1" });
  });
  it("integration review: an integration finding opens with no build subject or brief", () => {
    const onOpenItem = vi.fn();
    wrap(<AssessmentViewer assessment={assessment()} brief={missing} result={missing} cohortLabel="final" isIntegration source={{ revision_id: revisionId("run-1/integration/final", "assessment", INTEGRATION.source_revision_id) }} onOpenItem={onOpenItem} />);
    fireEvent.click(requireControl(screen.getAllByTestId("or-grade-item"), 0));
    expect(onOpenItem).toHaveBeenCalledWith({ source_revision_id: INTEGRATION.source_revision_id, item_path: "/findings/1" });
  });
  it("final integration panel: lists integration findings, unlinked included, and opens them", async () => {
    const onOpenItem = vi.fn();
    const profile = { title: "t", lifecycle_state: "integrating", final_merge_policy: "external_confirmation", base_branch: "b", repositories: [] } as unknown as EpicWorkflowProfile;
    wrap(<FinalIntegrationPanel runId="run-1" profile={profile} onOpenItem={onOpenItem} />);
    fireEvent.click(await screen.findByTestId("or-grade-item"));
    expect(onOpenItem).toHaveBeenCalledWith(INTEGRATION);
  });
  it("grading section and drilldown use the same address", async () => {
    const onOpenItem = vi.fn();
    useGradingVisibility.getState().revealComposites("run-1");
    wrap(<RunGradingSection runId="run-1" onOpenItem={onOpenItem} onOpenTask={vi.fn()} />);
    await screen.findAllByTestId("or-stage-finding");
    const analysisStage = screen.getAllByTestId("or-stage-findings").find((stage) => stage.dataset.stage === "analysis");
    if (!analysisStage) throw new Error("analysis stage missing");
    fireEvent.click(requireControl(within(analysisStage).getAllByTestId("or-grade-item"), 0));
    expect(onOpenItem).toHaveBeenCalledWith(ANALYSIS);
  });
});

it("passes the selected task through status, lineage, own-answer reads and submission", async () => {
  const task_id = id<import("../grading-contracts/domain/identity").ObservationLogicalItemId>("task-3");
  const question = supportQuestion({ task_id });
  world.status = itemStatus([{ ...question, evidence: { ...question.evidence, task_id } }]);
  wrap(<ItemPanel runId="run-1" selection={{ ...IMPLEMENTATION, task_id }} onOpenTask={vi.fn()} />);
  const choices = await screen.findAllByTestId("or-your-grade-choice");
  fireEvent.click(requireControl(choices, 0));
  fireEvent.click(screen.getByTestId("or-your-grade-submit"));
  await screen.findByTestId("or-your-grade-saved");
  expect(world.sent).toMatchObject([{ task_id }]);
  for (const surface of ["status", "lineage", "answers"]) {
    expect(world.paths.some((path) => {
      const url = new URL(path, "http://kbbl.test");
      return url.pathname.endsWith(`/${surface}`) && url.searchParams.get("task_id") === task_id;
    })).toBe(true);
  }
});

it("opens a recorded grading question by exact id and version beyond the first page", async () => {
  const target: ObservationQuestionKey = { question_id: id("target-question"), question_version: "v2" };
  const question = supportQuestion();
  const originalFetch = vi.mocked(globalThis.fetch).getMockImplementation();
  if (!originalFetch) throw new Error("grading fetch fixture missing");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://kbbl.test");
    if (url.pathname.endsWith("/status")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const entry = offset === 0 ? question : { ...question, question: { ...question.question, ...target, question_text: "Exact recorded question" } };
      return json(itemStatus([entry], { questions: { ...paged([entry]), total: 201, offset } }));
    }
    return originalFetch(input, init);
  });
  wrap(<ItemPanel runId="run-1" selection={IMPLEMENTATION} questionTarget={target} onOpenTask={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("or-item-question-text").textContent).toContain("Exact recorded question"));
});
