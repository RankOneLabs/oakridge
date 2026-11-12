import { ariaText, documentText, json, world, wrap } from "./item-panel-harness";
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { ANALYSIS, IMPLEMENTATION, INTEGRATION, item, paged, supportQuestion, taskComposite } from "../__fixtures__/grading";
import { RunGradingSection } from "../components/organisms/RunGradingSection";
import { TaskPanel } from "../components/organisms/TaskPanel";
import type { ObservationCompositeRead } from "../grading-contracts/grading/item-reads";

describe("the grading section and task drilldown", () => {
  const section = () => wrap(<RunGradingSection runId="run-1" onOpenItem={vi.fn()} onOpenTask={vi.fn()} />);
  it("hidden: lists tasks and every stage's findings with no count, badge or label that reveals an answer", async () => {
    section();
    await screen.findByTestId("or-grading-task");
    await screen.findAllByTestId("or-stage-finding");
    expect(screen.queryByTestId("or-task-stage-counts")).toBeNull();
    expect(screen.queryByTestId("or-task-answer-count")).toBeNull();
    expect(screen.queryByTestId("or-grading-spend")).toBeNull();
    const text = documentText();
    for (const marker of ["does not support", "does_not_support", "Budget deferred", "Disagreement", ": 7", ": 9", "13 provider"]) expect({ marker, found: text.includes(marker) }).toEqual({ marker, found: false });
    expect(ariaText()).not.toContain("does not support");
    expect(screen.getByTestId("or-grading-state").textContent).toBe("Automatic grading off");
  });
  it("reveals composites before any answer, keeps stages separate, labels final results and opens raw answers", async () => {
    section();
    fireEvent.click(await screen.findByTestId("or-composites-reveal"));
    const stages = await screen.findAllByTestId("or-task-stage");
    expect(stages.map((stage) => stage.getAttribute("data-stage"))).toEqual(["analysis", "implementation", "integration"]);
    expect(stages[0]!.textContent).toContain("Pending");
    expect(within(stages[0]!).queryByTestId("or-task-coverage-gap")).toBeNull();
    expect(stages[2]!.textContent).toContain("Final results");
    expect(within(stages[1]!).getByTestId("or-task-answer-count").textContent).toBe("items: 7");
    expect(within(stages[1]!).getByTestId("or-task-status-count").textContent).toContain("Budget deferred");
    expect(within(stages[1]!).getByTestId("or-task-disagreement-count").textContent).toBe("items: 9");
    fireEvent.click(within(stages[1]!).getByTestId("or-task-answer-count"));
    const row = await screen.findByTestId("or-task-drilldown-row");
    expect(row.textContent).toContain("Reviewer second-reviewer");
    expect(row.textContent).toContain("does not support");
    expect(world.paths.some((path) => path.includes("/drilldown") && path.includes(encodeURIComponent('"marker":"support"')))).toBe(true);
    expect(world.sent).toEqual([]);
    fireEvent.click(screen.getByTestId("or-composites-hide"));
    expect(screen.queryByTestId("or-task-drilldown")).toBeNull();
    expect(documentText()).not.toContain("second-reviewer");
  });
  it("paging one task's stage moves only that list, and its pager stays when the page is empty", async () => {
    const many = (id: string, offset = 0): ObservationCompositeRead => {
      const task = taskComposite(id);
      return { ...task, stages: { ...task.stages, items: task.stages.items.map((stage) => stage.stage !== "implementation" ? stage
        : { ...stage, answers: offset === 0 ? { ...stage.answers, total: 51 } : paged([], 51, 50, offset) }) } };
    };
    const base = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://kbbl.test");
      if (url.pathname.endsWith("/runs/run-1/tasks")) { world.paths.push(url.pathname + url.search); return json(paged([many("T1"), many("T2")])); }
      if (url.pathname.endsWith("/runs/run-1/tasks/T1")) { world.paths.push(url.pathname + url.search); return json(many("T1", Number(url.searchParams.get("answers_offset") ?? 0))); }
      return base(input, init);
    });
    section();
    fireEvent.click(await screen.findByTestId("or-composites-reveal"));
    const [first, second] = await screen.findAllByTestId("or-grading-task");
    const implementation = (task: HTMLElement) => within(task).getAllByTestId("or-task-stage").find((stage) => stage.getAttribute("data-stage") === "implementation")!;
    fireEvent.click(within(implementation(first!)).getByTestId("or-pager-answers-next"));
    await waitFor(() => expect(within(implementation(first!)).getByTestId("or-pager-answers").textContent).toContain("51–51 of 51"));
    expect(within(implementation(first!)).queryByTestId("or-task-answer-count")).toBeNull();
    expect(within(implementation(second!)).getByTestId("or-task-answer-count").textContent).toBe("items: 7");
    expect(world.paths.filter((path) => path.includes("answers_offset=50"))).toEqual([expect.stringContaining("/tasks/T1?")]);
  });
  it("a drilldown shows the frozen evidence behind its count", async () => {
    section();
    fireEvent.click(await screen.findByTestId("or-composites-reveal"));
    fireEvent.click((await screen.findAllByTestId("or-task-answer-count"))[0]!);
    const row = await screen.findByTestId("or-task-drilldown-row");
    expect(within(row).getByTestId("or-item-evidence")).toBeTruthy();
    expect(within(row).getAllByTestId("or-item-evidence-reference").length).toBe(supportQuestion().evidence.references.items.length);
  });
  it("choosing another count starts its drilldown on the first page", async () => {
    const base = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://kbbl.test");
      if (!url.pathname.endsWith("/drilldown")) return base(input, init);
      world.paths.push(url.pathname + url.search);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json(paged([{ item: item(IMPLEMENTATION), links: paged([]), questions: paged([]) }], 41, 20, offset));
    });
    section();
    fireEvent.click(await screen.findByTestId("or-composites-reveal"));
    const stages = await screen.findAllByTestId("or-task-stage");
    fireEvent.click(within(stages[1]!).getByTestId("or-task-answer-count"));
    fireEvent.click(await screen.findByTestId("or-pager-drilldown-next"));
    await waitFor(() => expect(world.paths.some((path) => path.includes("/drilldown") && path.includes("offset=20"))).toBe(true));
    world.paths = [];
    fireEvent.click(within(stages[1]!).getByTestId("or-task-status-count"));
    await waitFor(() => expect(world.paths.some((path) => path.includes("/drilldown"))).toBe(true));
    expect(world.paths.filter((path) => path.includes("/drilldown")).every((path) => !path.includes("offset=20"))).toBe(true);
  });
  it("lists findings by stage, marks the unlinked and keeps unresolved references visible", async () => {
    section();
    await waitFor(() => expect(screen.getAllByTestId("or-stage-finding")).toHaveLength(3));
    const rows = screen.getAllByTestId("or-stage-finding");
    expect(rows.map((row) => row.getAttribute("data-revision"))).toEqual([ANALYSIS.source_revision_id, IMPLEMENTATION.source_revision_id, INTEGRATION.source_revision_id]);
    expect(within(rows[2]!).getByTestId("or-finding-unlinked")).toBeTruthy();
    expect(within(rows[1]!).getByTestId("or-finding-task-link").getAttribute("data-link-state")).toBe("unresolved");
    expect((await screen.findByTestId("or-grading-unresolved-reference")).textContent).toContain("logical_item:task:T404");
  });
  it("an observation outage leaves the section standing and says so", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => json({ error: { code: "observation_not_configured", message: "not deployed" } }, 503));
    section();
    expect((await screen.findByTestId("or-grading-unavailable")).textContent).toContain("not deployed");
    expect(await screen.findByTestId("or-grading-tasks-unavailable")).toBeTruthy();
    expect(await screen.findByTestId("or-grading-stages-unavailable")).toBeTruthy();
  });
  it("a task panel for an uncaptured id says unresolved and stays open; a known one lists its linked items hidden", async () => {
    wrap(<TaskPanel runId="run-1" taskId="T404" onOpenItem={vi.fn()} />);
    expect(await screen.findByTestId("or-task-unresolved")).toBeTruthy();
    cleanup();
    wrap(<TaskPanel runId="run-1" taskId="T1" onOpenItem={vi.fn()} />);
    expect((await screen.findByTestId("or-task-linked-item")).textContent).toContain("the narrow finding");
    expect(documentText()).not.toContain("does not support");
    fireEvent.click(screen.getByTestId("or-composites-reveal"));
    expect((await screen.findByTestId("or-task-answer-count")).textContent).toBe("items: 7");
  });
});
