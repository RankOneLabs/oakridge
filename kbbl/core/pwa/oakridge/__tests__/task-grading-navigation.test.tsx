import { json, world, wrap } from "./item-panel-harness";
import { expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { acknowledged, ANALYSIS, id, IMPLEMENTATION, item, itemStatus, paged, supportQuestion } from "../__fixtures__/grading";
import { CompositeDrilldown } from "../components/organisms/CompositeDrilldown";
import { ItemPanel } from "../components/organisms/ItemPanel";
import { TaskPanel } from "../components/organisms/TaskPanel";
import type { ObservationLogicalItemId } from "../grading-contracts/domain/identity";
import type { ObservationLineageEntry } from "../grading-contracts/grading/composite";
import type { ObservationDrilldownRowRead, ObservationItemAddress } from "../grading-contracts/grading/item-reads";
import type { ObservationQuestionStatusResponse } from "../grading-contracts/storage/grading-record-store";

const task_id = id<ObservationLogicalItemId>("l1");
type EntryPoint = "task panel" | "composite drilldown";

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
    // Match observation's exact subject filter so a task filter cannot accidentally expose relevance.
    if (url.pathname.endsWith("/status")) {
      world.paths.push(url.pathname + url.search);
      return json({ ...world.status, questions: paged(world.status.questions.items.filter((question) =>
        !url.searchParams.has("task_id") || question.task_id === url.searchParams.get("task_id"))) });
    }
    return boundary(input, init);
  });
}

const entryPoint = (source: EntryPoint, open: (selection: ObservationItemAddress) => void) => source === "task panel"
  ? <TaskPanel runId="run-1" taskId="T1" onOpenItem={open} />
  : <CompositeDrilldown runId="run-1" drilldownKey={{ logical_item_id: task_id, stage: "analysis", selector: { kind: "items" } }} label="Linked items" onClose={vi.fn()} onOpenItem={open} />;

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
  wrap(<ItemPanel runId="run-1" selection={selection} onOpenTask={vi.fn()} />);
  expect((await screen.findByTestId("or-item-question")).textContent).toBe("Relevance");
  fireEvent.click((await screen.findAllByTestId("or-your-grade-choice"))[0]!);
  fireEvent.click(screen.getByTestId("or-your-grade-submit"));
  expect((await screen.findByTestId("or-your-grade-saved")).textContent).toContain("relevant");
  expect(world.sent).toMatchObject([{ task_id: null, question_id: "finding.relevance", answer: "relevant" }]);
  const statusPaths = world.paths.filter((path) => new URL(path, "http://kbbl.test").pathname.endsWith("/status"));
  expect(statusPaths.length).toBeGreaterThan(0);
  expect(statusPaths.every((path) => !new URL(path, "http://kbbl.test").searchParams.has("task_id"))).toBe(true);
});

it.each<EntryPoint>(["task panel", "composite drilldown"])("an assessment finding opened from the %s keeps its task subject", async (source) => {
  const question = supportQuestion({ task_id });
  world.status = itemStatus([{ ...question, evidence: { ...question.evidence, task_id } }]);
  navigationReads();
  const open = vi.fn();
  wrap(entryPoint(source, open));
  fireEvent.click(await screen.findByTestId("or-grade-item"));
  expect(open).toHaveBeenCalledWith({ ...IMPLEMENTATION, task_id });
});
