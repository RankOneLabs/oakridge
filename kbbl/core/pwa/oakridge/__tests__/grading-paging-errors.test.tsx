import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { paged, taskComposite } from "../__fixtures__/grading";
import { PagedStageColumn } from "../components/organisms/PagedStageColumn";
import { TaskStageComposites } from "../components/organisms/TaskStageComposites";
import type { ObservationCompositeRead, ObservationStageCompositeRead } from "../grading-contracts/grading/item-reads";

const clients: QueryClient[] = [];
const mount = (node: ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
};
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.restoreAllMocks(); });

test("a failed nested page keeps the last successful answer page and can retry that exact window", async () => {
  const task = taskComposite();
  const original = task.stages.items[1]!;
  const answer = original.answers.items[0]!;
  const stageAt = (offset: number): ObservationStageCompositeRead => ({ ...original,
    answers: paged([{ ...answer, count: offset + 1 }], 3, 1, offset) });
  let shouldFail = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const offset = Number(new URL(String(input), "http://kbbl.test").searchParams.get("answers_offset"));
    if (offset === 2 && shouldFail) return Response.json({ error: { message: "answers page unavailable" } }, { status: 503 });
    return Response.json({ ...task, stages: paged([stageAt(offset)]) });
  });
  mount(<PagedStageColumn runId="run-1" taskId="T1" stage={stageAt(0)} stagesWindow={null} isRevealed onDrill={vi.fn()} />);
  fireEvent.click(screen.getByTestId("or-pager-answers-next"));
  await waitFor(() => expect(screen.getByTestId("or-task-answer-count").textContent).toBe("items: 2"));
  fireEvent.click(screen.getByTestId("or-pager-answers-next"));
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain("answers page unavailable");
  expect(screen.getByTestId("or-task-answer-count").textContent).toBe("items: 2");
  expect(screen.getByTestId("or-pager-answers").textContent).toContain("2–2 of 3");
  shouldFail = false;
  fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByTestId("or-task-answer-count").textContent).toBe("items: 3"));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a failed stages page keeps the last successful stages and retries without resetting their offset", async () => {
  const task = taskComposite();
  let shouldFail = true;
  const offsets: number[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const offset = Number(new URL(String(input), "http://kbbl.test").searchParams.get("stages_offset"));
    offsets.push(offset);
    if (offset === 2 && shouldFail) return Response.json({ error: { message: "stages page unavailable" } }, { status: 503 });
    const result: ObservationCompositeRead = { ...task, stages: paged([task.stages.items[offset]!], 3, 1, offset) };
    return Response.json(result);
  });
  mount(<TaskStageComposites runId="run-1" taskId="T1" stages={paged([task.stages.items[0]!], 3, 1)} isRevealed onDrill={vi.fn()} />);
  fireEvent.click(screen.getByTestId("or-pager-stages-next"));
  await waitFor(() => expect(screen.getByTestId("or-task-stage").getAttribute("data-stage")).toBe("implementation"));
  fireEvent.click(screen.getByTestId("or-pager-stages-next"));
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain("stages page unavailable");
  expect(screen.getByTestId("or-task-stage").getAttribute("data-stage")).toBe("implementation");
  expect(screen.getByTestId("or-pager-stages").textContent).toContain("2–2 of 3");
  shouldFail = false;
  fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByTestId("or-task-stage").getAttribute("data-stage")).toBe("integration"));
  expect(offsets).toEqual([1, 2, 2]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("paging failure data never leaks into another task", async () => {
  const first = taskComposite();
  const second = taskComposite("T2");
  const stage = { ...first.stages.items[1]!, answers: { ...first.stages.items[1]!.answers, total: 51 } };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...first,
    stages: paged([{ ...stage, answers: paged([{ ...stage.answers.items[0]!, count: 99 }], 51, 50, 50) }]) }));
  const node = (taskId: string, shown: ObservationStageCompositeRead) => <PagedStageColumn runId="run-1" taskId={taskId} stage={shown} stagesWindow={null} isRevealed onDrill={vi.fn()} />;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const view = render(<QueryClientProvider client={client}>{node("T1", stage)}</QueryClientProvider>);
  fireEvent.click(screen.getByTestId("or-pager-answers-next"));
  await waitFor(() => expect(screen.getByTestId("or-task-answer-count").textContent).toBe("items: 99"));
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ error: { message: "second task unavailable" } }, { status: 503 }));
  view.rerender(<QueryClientProvider client={client}>{node("T2", second.stages.items[1]!)}</QueryClientProvider>);
  await screen.findByRole("alert");
  expect(screen.getByTestId("or-task-answer-count").textContent).toBe("items: 7");
});

test("task stages render arbitrary projection order and all four distinct states", () => {
  const original = taskComposite().stages.items[0];
  if (!original) throw new Error("fixture stage missing");
  const stages: ObservationStageCompositeRead[] = [
    { ...original, stage: "compliance_audit", state: "not_graded" },
    { ...original, stage: "release", state: "pending" },
    { ...original, stage: "custom_check", state: "gap", publication: { state: "published", is_final: false, unit_ids: paged([]) } },
    { ...original, stage: "finish", state: "linked", totals: { ...original.totals, contributing_items: 1 }, publication: { state: "published", is_final: true, unit_ids: paged([]) } },
  ];
  mount(<TaskStageComposites runId="run-1" taskId="T1" stages={paged(stages)} isRevealed={false} onDrill={vi.fn()} />);
  const columns = screen.getAllByTestId("or-task-stage");
  expect(columns.map((column) => column.dataset.stage)).toEqual(["compliance_audit", "release", "custom_check", "finish"]);
  expect(columns.map((column) => column.textContent)).toEqual(["Compliance AuditNot graded", "ReleasePending", "Custom CheckPublishedNo linked items", "FinishFinal results1 linked item"]);
});
