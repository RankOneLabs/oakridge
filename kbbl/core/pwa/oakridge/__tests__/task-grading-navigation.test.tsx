import { json, world, wrap } from "./item-panel-harness";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { acknowledged, ANALYSIS, correctnessQuestion, id, IMPLEMENTATION, item, itemStatus, paged, supportQuestion } from "../__fixtures__/grading";
import { CompositeDrilldown } from "../components/organisms/CompositeDrilldown";
import { ItemPanel } from "../components/organisms/ItemPanel";
import { TaskPanel } from "../components/organisms/TaskPanel";
import type { ObservationEvidenceSetId, ObservationLogicalItemId } from "../grading-contracts/domain/identity";
import type { ObservationLineageEntry } from "../grading-contracts/grading/composite";
import type { ObservationDrilldownRowRead, ObservationItemAddress } from "../grading-contracts/grading/item-reads";
import type { ObservationQuestionStatusResponse } from "../grading-contracts/storage/grading-record-store";

const task_id = id<ObservationLogicalItemId>("l1");
type EntryPoint = "task panel" | "composite drilldown";
afterEach(() => vi.useRealTimers());

function navigationReads() {
  const boundary = vi.mocked(globalThis.fetch).getMockImplementation();
  if (!boundary) throw new Error("item-panel IO boundary is missing");
  const contribution: ObservationLineageEntry = { kind: "contribution", relation_id: id("rel-1"), evidence_ref: "/findings/0/task_ids/0", asserted_by: "producer_explicit", item: world.status.item };
  const row: ObservationDrilldownRowRead = { item: world.status.item, links: paged([]), questions: paged(world.status.questions.items.map((question) => ({
    task_id: question.task_id, is_linked_context: question.task_id === null, question: question.question, evidence: question.evidence,
    statuses: paged([]), answers: paged([]), superseded_answers: paged([]),
  }))) };
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://kbbl.test");
    if (url.pathname.endsWith("/tasks/T1/lineage")) return json({ ...paged([contribution]), run_id: id("run-1"), producer_local_id: "T1", is_captured: true });
    if (url.pathname.endsWith("/drilldown")) return json(paged([row]));
    // Match observation's exact subject filter and question window, so a task filter cannot accidentally
    // expose relevance and a subject outside the window is not read.
    if (url.pathname.endsWith("/status")) {
      world.paths.push(url.pathname + url.search);
      const subjects = world.status.questions.items.filter((question) =>
        !url.searchParams.has("task_id") || question.task_id === url.searchParams.get("task_id"));
      const limit = Number(url.searchParams.get("limit") ?? "50"), offset = Number(url.searchParams.get("offset") ?? "0");
      return json({ ...world.status, questions: paged(subjects.slice(offset, offset + limit), subjects.length, limit, offset) });
    }
    return boundary(input, init);
  });
}

const entryPoint = (source: EntryPoint, open: (selection: ObservationItemAddress) => void) => source === "task panel"
  ? <TaskPanel runId="run-1" taskId="T1" onOpenItem={open} />
  : <CompositeDrilldown runId="run-1" drilldownKey={{ logical_item_id: task_id, stage: "analysis", selector: { kind: "items" } }} label="Linked items" onClose={vi.fn()} onOpenItem={open} />;

it("an unfiltered finding labels each task's questions and the task being graded", async () => {
  const subjects = ["T3", "T7"].flatMap((name) => {
    const task_id = id<ObservationLogicalItemId>(`logical-${name}`);
    return [correctnessQuestion({ human: { state: "ready" } }), supportQuestion()].map((question): ObservationQuestionStatusResponse => ({
      ...question, task_id, evidence: { ...question.evidence, task_id, evidence_set_id: id(`${name}-${question.question.question_id}`) },
    }));
  });
  world.status = itemStatus(subjects, { links: paged(["T3", "T7"].map((name) => ({
    state: "resolved", producer_local_id: name, logical_item_id: id(`logical-${name}`), relation_id: id(`relation-${name}`), evidence_ref: "/findings/1/task_ids/0",
  }))) });
  wrap(<ItemPanel runId="run-1" selection={IMPLEMENTATION} onOpenTask={vi.fn()} />);
  const tabs = await screen.findAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Correctness · Task T3", "Evidence support · Task T3", "Correctness · Task T7", "Evidence support · Task T7",
  ]);
  expect(screen.getByTestId("or-item-question-task").textContent).toBe("Task T3");
  fireEvent.click(screen.getByRole("tab", { name: "Evidence support · Task T7" }));
  expect(screen.getByTestId("or-item-question-task").textContent).toBe("Task T7");
  fireEvent.click(screen.getByRole("radio", { name: "supports" }));
  fireEvent.click(screen.getByTestId("or-your-grade-submit"));
  await screen.findByTestId("or-your-grade-saved");
  expect(world.sent).toMatchObject([{ task_id: "logical-T7", question_id: "assessment_finding.evidence_support", answer: "supports" }]);
});

it.each<EntryPoint>(["task panel", "composite drilldown"])("an analysis finding opened from the %s shows and accepts relevance", async (source) => {
  const support = supportQuestion();
  const relevance: ObservationQuestionStatusResponse = { ...support, task_id: null, question: { ...support.question, question_id: id("finding.relevance"), item_kind: "finding", allowed_values: ["relevant", "irrelevant", "unclear"] },
    evidence: { ...support.evidence, task_id: null, question_id: id("finding.relevance") }, answers: paged([]), machine: paged([]) };
  world.status = itemStatus([relevance], { item: item(ANALYSIS, { artifact_kind: "analysis", item_kind: "finding", stage: "analysis" }) }, ANALYSIS);
  world.submit = () => json(acknowledged("relevant", { question: relevance.question }), 201);
  navigationReads();
  const open = vi.fn<(selection: ObservationItemAddress) => void>();
  wrap(entryPoint(source, open));
  fireEvent.click(await screen.findByTestId("or-grade-item"));
  expect(open).toHaveBeenCalledWith(ANALYSIS);
  const selection = open.mock.calls[0]?.[0];
  if (!selection) throw new Error("the finding did not open");
  cleanup();
  world.paths.length = 0;
  wrap(<ItemPanel runId="run-1" selection={selection} onOpenTask={vi.fn()} />);
  expect((await screen.findByTestId("or-item-question")).textContent).toBe("Relevance");
  fireEvent.click(await screen.findByRole("radio", { name: "relevant" }));
  fireEvent.click(screen.getByTestId("or-your-grade-submit"));
  expect((await screen.findByTestId("or-your-grade-saved")).textContent).toContain("relevant");
  expect(world.sent).toMatchObject([{ task_id: null, question_id: "finding.relevance", answer: "relevant" }]);
  const statusPaths = world.paths.filter((path) => new URL(path, "http://kbbl.test").pathname.endsWith("/status"));
  expect(statusPaths.length).toBeGreaterThan(0);
  expect(statusPaths.every((path) => !new URL(path, "http://kbbl.test").searchParams.has("task_id"))).toBe(true);
});

it.each<{ source: EntryPoint; item_kind: string }>([
  { source: "task panel", item_kind: "assessment_finding" },
  { source: "task panel", item_kind: "future_item_kind" },
  { source: "composite drilldown", item_kind: "assessment_finding" },
  { source: "composite drilldown", item_kind: "future_item_kind" },
])("a $item_kind opened from the $source keeps its pinned task subject", async ({ source, item_kind }) => {
  const question = supportQuestion({ task_id });
  world.status = itemStatus([{ ...question, question: { ...question.question, item_kind }, evidence: { ...question.evidence, task_id } }], { item: item(IMPLEMENTATION, { item_kind }) });
  navigationReads();
  const open = vi.fn();
  wrap(entryPoint(source, open));
  fireEvent.click(await screen.findByTestId("or-grade-item"));
  expect(open).toHaveBeenCalledWith({ ...IMPLEMENTATION, task_id });
});

it("the task panel keeps the enclosing task's subject when other tasks' subjects fill a whole question page", async () => {
  const others = Array.from({ length: 250 }, (_, index) => {
    const other = id<ObservationLogicalItemId>(`other-${index}`);
    const question = supportQuestion({ task_id: other });
    return { ...question, evidence: { ...question.evidence, task_id: other, evidence_set_id: id<ObservationEvidenceSetId>(`other-${index}-support`) } };
  });
  const own = supportQuestion({ task_id });
  world.status = itemStatus([...others, { ...own, evidence: { ...own.evidence, task_id } }]);
  navigationReads();
  const open = vi.fn();
  wrap(entryPoint("task panel", open));
  fireEvent.click(await screen.findByTestId("or-grade-item"));
  expect(open).toHaveBeenCalledWith({ ...IMPLEMENTATION, task_id });
});

it("an unfiltered item pages past its first 200 question subjects", async () => {
  world.status = itemStatus(Array.from({ length: 201 }, (_, index) => {
    const subject = id<ObservationLogicalItemId>(`task-${index}`);
    const question = supportQuestion({ task_id: subject });
    return { ...question, evidence: { ...question.evidence, task_id: subject, evidence_set_id: id<ObservationEvidenceSetId>(`task-${index}-support`) } };
  }));
  navigationReads();
  wrap(<ItemPanel runId="run-1" selection={IMPLEMENTATION} onOpenTask={vi.fn()} />);
  expect(await screen.findAllByRole("tab")).toHaveLength(200);
  fireEvent.click(screen.getByTestId("or-pager-questions-next"));
  await screen.findByText("201–201 of 201");
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("tab").getAttribute("aria-selected")).toBe("true");
});

it("an assessment finding with no pinned subject for the enclosing task opens without a task filter", async () => {
  const question = supportQuestion({ task_id: id<ObservationLogicalItemId>("other-task") });
  world.status = itemStatus([question]);
  navigationReads();
  const open = vi.fn();
  wrap(entryPoint("task panel", open));
  fireEvent.click(await screen.findByTestId("or-grade-item"));
  expect(open).toHaveBeenCalledWith(IMPLEMENTATION);
});

it("a 50-row task lineage reads each contribution's status once while lineage keeps refreshing", async () => {
  vi.useFakeTimers();
  const boundary = vi.mocked(globalThis.fetch).getMockImplementation();
  if (!boundary) throw new Error("item-panel IO boundary is missing");
  const contributions: ObservationLineageEntry[] = Array.from({ length: 50 }, (_, index) => ({
    kind: "contribution", relation_id: id(`relation-${index}`), evidence_ref: `/findings/${index}/task_ids/0`, asserted_by: "producer_explicit",
    item: { ...world.status.item, occurrence_id: id(`occurrence-${index}`), item_path: `/findings/${index}` },
  }));
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://kbbl.test");
    if (url.pathname.endsWith("/tasks/T1/lineage")) {
      world.paths.push(url.pathname + url.search);
      return json({ ...paged(contributions), run_id: id("run-1"), producer_local_id: "T1", is_captured: true });
    }
    return boundary(input, init);
  });
  wrap(<TaskPanel runId="run-1" taskId="T1" onOpenItem={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getAllByTestId("or-grade-item")).toHaveLength(50);
  const statusReads = () => world.paths.filter((path) => new URL(path, "http://kbbl.test").pathname.endsWith("/status"));
  expect(statusReads()).toHaveLength(50);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
  expect(world.paths.filter((path) => path.includes("/tasks/T1/lineage")).length).toBeGreaterThan(1);
  expect(statusReads()).toHaveLength(50);
});
