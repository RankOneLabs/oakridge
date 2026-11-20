import { json, world, wrap, requireControl } from "./item-panel-harness";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { id, IMPLEMENTATION, INTEGRATION, ANALYSIS, itemStatus, paged, supportQuestion } from "../__fixtures__/grading";
import { FinalIntegrationPanel } from "../components/organisms/FinalIntegrationPanel";
import { ItemPanel } from "../components/organisms/ItemPanel";
import { RunGradingSection } from "../components/organisms/RunGradingSection";
import type { ObservationQuestionKey } from "../grading-contracts/grading/question";
import { useGradingVisibility } from "../state/gradingVisibility";
import type { EpicWorkflowProfile } from "../run-types";

describe("every entry point opens the same item", () => {
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
