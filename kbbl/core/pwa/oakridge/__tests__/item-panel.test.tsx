import { ItemPanel } from "../components/organisms/ItemPanel";
import { useGradingVisibility } from "../state/gradingVisibility";
import { ariaText, documentText, json, panel, world, wrap, requireControl } from "./item-panel-harness";
import plan from "../lib/__fixtures__/id-linked-plan.json";
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { id, IMPLEMENTATION, ANALYSIS, item, itemStatus, machine, paged, reviewerAnswer, supportQuestion } from "../__fixtures__/grading";
import type { ObservationEvidenceReference } from "../grading-contracts/grading/evidence";

it.each(["task", "acceptance_entry"])("shows a %s's captured text and explicit spec-task identity", async (item_kind) => {
  const open = vi.fn();
  world.status = itemStatus([supportQuestion()], { item: item(IMPLEMENTATION, { item_kind,
    selected_value: item_kind === "task" ? { id: "T7", description: "Define organizations" } : { id: "T7", text: "Expose organization reads" } }), links: paged([]) });
  panel(open);
  const task = await screen.findByTestId("or-item-spec-task");
  expect(task.textContent).toBe("T7");
  expect(screen.getAllByText(item_kind === "task" ? "Define organizations" : "Expose organization reads").length).toBeGreaterThan(0);
  expect(screen.queryByText("None linked")).toBeNull();
  fireEvent.click(task);
  expect(open).toHaveBeenCalledWith("T7");
});
// The fixture supplies each reference row; ItemPanel always renders its header once loaded.
it("renders structured evidence and an assessment header as labelled fields", async () => {
  const question = supportQuestion();
  world.status = itemStatus([{ ...question, evidence: { ...question.evidence, references: paged<ObservationEvidenceReference>([
    { source: "revision", ref: "requirement:0", revision_id: id("analysis:1"), item_path: "/requirements/0", content: { id: "R1", description: "Render fields", status: "implementable" } },
    { source: "revision", ref: "task_context:0", revision_id: id("brief:1"), item_path: null, content: { commitSha: "abc123", task_ids: ["T7"] } },
  ]) } }], { item: item(IMPLEMENTATION, { selected_value: { status: "met", task_ids: ["T1"], evidence: [] } }) });
  panel();
  const references = await screen.findAllByTestId("or-item-evidence-reference");
  for (const label of ["Id", "Description", "Status"]) expect(within(requireControl(references, 0)).getByText(label)).toBeTruthy();
  expect(within(requireControl(references, 1)).getByText("Commit sha")).toBeTruthy();
  for (const reference of references) expect(reference.textContent).not.toMatch(/\{"|":/);
  const header = screen.getByTestId("or-item-panel").querySelector("header")!;
  expect(["Status", "Task ids", "met", "T1"].every((text) => within(header).queryAllByText(text).length > 0)).toBe(true);
  expect(header.textContent).not.toContain("No description recorded.");
});
it("expands whole-artifact fields independently and leaves cohort context inline", async () => {
  const question = supportQuestion();
  world.status = itemStatus([{ ...question, evidence: { ...question.evidence, references: paged<ObservationEvidenceReference>([
    { source: "revision", ref: "plan", revision_id: id("plan:1"), item_path: null, content: plan },
    { source: "revision", ref: "spec", revision_id: id("spec:1"), item_path: null, content: "First line\nMore specification" },
    { source: "revision", ref: "contribution_context", revision_id: id("plan:1"), item_path: "/cohorts/0", content: plan.cohorts[0]! },
  ]) } }]);
  panel();
  const [whole, spec, cohort] = await screen.findAllByTestId("or-item-evidence-reference");
  if (!whole || !spec || !cohort) throw new Error("evidence fixture requires all three controls");
  expect(within(whole).queryByText("Dependency order")).toBeNull();
  expect(within(cohort).getByText("Files in scope")).toBeTruthy();
  fireEvent.click(within(whole).getByRole("button", { name: "Show fields" }));
  expect(within(whole).getByText("Dependency order")).toBeTruthy();
  expect(within(spec).getByRole("button", { name: "Show fields" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(within(whole).getByRole("button", { name: "Hide fields" }));
  expect(within(whole).queryByText("Dependency order")).toBeNull();
});
/** The operator's own form lists every choice, so a hidden answer is searched for by what only an answer row shows. */
const REVEALING = ["second-reviewer", "leak-marker", "jev-1.14.0", "Answers (", "attempt", "Correction history", "Automatic evaluators"];

describe("hidden mode", () => {
  it("omits other answers and evaluators from the text, labels and DOM while the form and readiness stay usable", async () => {
    panel();
    await screen.findByTestId("or-item-answers-hidden");
    for (const marker of REVEALING) {
      expect({ marker, found: documentText().includes(marker) }).toEqual({ marker, found: false });
      expect({ marker, found: ariaText().includes(marker) }).toEqual({ marker, found: false });
      expect({ marker, found: document.body.innerHTML.includes(marker) }).toEqual({ marker, found: false });
    }
    expect(screen.queryByTestId("or-item-answers")).toBeNull();
    expect(screen.queryByTestId("or-item-machine-status")).toBeNull();
    expect(await screen.findAllByTestId("or-your-grade-choice")).toHaveLength(3);
    expect(screen.getByTestId("or-item-evidence")).toBeTruthy();
    expect(screen.queryAllByTestId("or-item-answer")).toEqual([]);
    expect(document.querySelector("[data-grader]")).toBeNull();
  });
  it("reveals before any human answer, with no answer submitted and no record written", async () => {
    panel();
    fireEvent.click(await screen.findByTestId("or-item-reveal"));
    const answers = await screen.findByTestId("or-item-answers");
    expect(within(answers).getAllByTestId("or-item-answer").map((row) => row.getAttribute("data-grader"))).toEqual(["machine", "human"]);
    expect(answers.textContent).toContain("does not support");
    expect(answers.textContent).toContain("Reviewer second-reviewer");
    expect(world.sent).toEqual([]);
    expect(world.paths.every((path) => !path.includes("assign") && !path.includes("visibility"))).toBe(true);
    fireEvent.click(screen.getByTestId("or-item-hide"));
    expect(screen.queryByTestId("or-item-answers")).toBeNull();
    expect(documentText()).not.toContain("second-reviewer");
  });
  it("a successful submission reveals its own item and leaves composites hidden", async () => {
    panel();
    fireEvent.click((await screen.findAllByTestId("or-your-grade-choice"))[0]!);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-saved");
    expect(await screen.findByTestId("or-item-answers")).toBeTruthy();
    expect(useGradingVisibility.getState().revealed_composite_run_ids.size).toBe(0);
  });
  it("a refused submission reveals nothing", async () => {
    world.submit = () => json({ error: { code: "not_ready", message: "still waiting" } }, 409);
    panel();
    fireEvent.click((await screen.findAllByTestId("or-your-grade-choice"))[0]!);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-refused");
    expect(screen.queryByTestId("or-item-answers")).toBeNull();
  });
});

describe("the panel's question states", () => {
  it("offers the question's exact choices and disables only the selected not-ready question", async () => {
    panel();
    const tabs = await screen.findAllByTestId("or-item-question");
    expect(tabs.map((tab) => tab.getAttribute("data-question"))).toEqual(["assessment_finding.evidence_support", "assessment_finding.correctness"]);
    expect((await screen.findAllByTestId("or-your-grade-choice")).map((input) => (input as HTMLInputElement).value)).toEqual(["supports", "does_not_support", "unclear"]);
    fireEvent.click(tabs[1]!);
    expect((await screen.findByTestId("or-your-grade-not-ready")).textContent).toContain("build_result_unavailable");
    expect(screen.queryByTestId("or-your-grade-choice")).toBeNull();
    fireEvent.click(tabs[0]!);
    expect(await screen.findAllByTestId("or-your-grade-choice")).toHaveLength(3);
  });
  it("relevance offers relevant, irrelevant and unclear", async () => {
    world.status = itemStatus([supportQuestion({ question: { ...supportQuestion().question, question_id: id("finding.relevance"), question_text: "Is this finding relevant?", allowed_values: ["relevant", "irrelevant", "unclear"] } })], {}, ANALYSIS);
    wrap(<ItemPanel runId="run-1" selection={ANALYSIS} onOpenTask={vi.fn()} />);
    expect((await screen.findAllByTestId("or-your-grade-choice")).map((input) => (input as HTMLInputElement).value)).toEqual(["relevant", "irrelevant", "unclear"]);
    expect(screen.getByTestId("or-item-question").textContent).toBe("Is this finding relevant?");
  });
  it("keeps not ready, off, pending, failed, deferred and real negative answers apart when revealed", async () => {
    world.status = itemStatus([supportQuestion({ machine: paged([
      machine({ state: "not_ready", code: "repository_unavailable", detail: "no clone" }), machine({ state: "grading_off" }), machine({ state: "pending", status: "claimed" }),
      machine({ state: "failed", terminal_cause: "retry_exhausted", error: "rate limited" }), machine({ state: "budget_deferred" }),
      machine({ state: "answered", observation_id: id("m"), answer: { state: "answered", kind: "choice", value: "does_not_support" } }) ]) })], { is_grading_enabled: false });
    panel();
    fireEvent.click(await screen.findByTestId("or-item-reveal"));
    const rows = await screen.findAllByTestId("or-item-machine-status");
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual(["not_ready", "grading_off", "pending", "failed", "budget_deferred", "answered"]);
    const labels = ["Not ready", "Automatic grading off", "Pending", "Failed", "Budget deferred", "does not support"];
    labels.forEach((label, index) => expect(within(rows[index]!).getByText(label, { exact: true })).toBeTruthy());
    expect(screen.getByTestId("or-item-grading-off")).toBeTruthy();
  });
  it("shows each provider attempt's outcome, failure, request and cost when revealed", async () => {
    world.status = itemStatus([supportQuestion({ machine: paged([machine({ state: "failed", terminal_cause: "retry_exhausted", error: "rate limited" }, { attempts: paged([
      { attempt: 1, request_sent: true, outcome: "failed", failure_category: "rate_limited", charged_cost: 0.01, admitted_estimate: 0.02, provider_request_id: "req-1" },
      { attempt: 2, request_sent: false, outcome: null, failure_category: null, charged_cost: 0, admitted_estimate: 0.02, provider_request_id: null }]) })]) })]);
    panel();
    fireEvent.click(await screen.findByTestId("or-item-reveal"));
    const attempts = await screen.findAllByTestId("or-item-attempt");
    expect(attempts.map((attempt) => attempt.textContent)).toEqual([
      "Attempt 1Failedrate_limitedrequest sent (req-1)cost 0.0100 of 0.0200 admitted", "Attempt 2In flightno request sentcost 0.0000 of 0.0200 admitted"]);
  });
  it("labels frozen references: repository provenance and agent-reported output", async () => {
    panel();
    const references = await screen.findAllByTestId("or-item-evidence-reference");
    expect(references.map((row) => row.getAttribute("data-source"))).toEqual(["repository", "reported"]);
    expect(requireControl(references, 0).textContent).toContain("oakridge src/a.ts:2-3 @ abc123");
    expect(requireControl(references, 1).textContent).toContain("Agent-reported");
  });
  it("a task link is navigation: it opens the task, and an unresolved one stays visible", async () => {
    const onOpenTask = vi.fn();
    panel(onOpenTask);
    const links = await screen.findAllByTestId("or-item-task-link");
    expect(links.map((link) => [link.textContent, link.getAttribute("data-link-state")])).toEqual([["T1", "resolved"], ["T404 (unresolved)", "unresolved"]]);
    fireEvent.click(links[1]!);
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(links[1]?.tagName).toBe("SPAN");
    fireEvent.click(links[0]!);
    expect(onOpenTask).toHaveBeenCalledWith("T1");
  });
  it("an unlinked item opens the same, with no task read and no approval control", async () => {
    world.status = itemStatus([supportQuestion()], { links: paged([]) });
    panel();
    await screen.findByTestId("or-item-panel");
    expect(screen.getByTestId("or-item-task-links").textContent).toContain("None linked");
    expect(world.paths.some((path) => path.includes("/tasks"))).toBe(false);
    expect(document.querySelector("[data-testid^='or-decision']")).toBeNull();
    expect(documentText()).not.toMatch(/Approve|Request changes/);
  });
  it("an item not yet captured says so, and an outage says the service is unavailable", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => json({ error: { code: "not_found", message: "no item" } }, 404));
    panel();
    expect(await screen.findByTestId("or-item-not-captured")).toBeTruthy();
    cleanup();
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => json({ error: { code: "observation_unreachable", message: "down" } }, 502));
    panel();
    expect((await screen.findByTestId("or-item-unavailable")).textContent).toContain("down");
  });
  it("pages a nested list by its own window", async () => {
    world.status = itemStatus([supportQuestion({ answers: paged([reviewerAnswer("a1", "unclear", "r1")], 51, 50, 0) })]);
    panel();
    fireEvent.click(await screen.findByTestId("or-item-reveal"));
    fireEvent.click(await screen.findByTestId("or-pager-answers-next"));
    await waitFor(() => expect(world.paths.some((path) => path.includes("answers_offset=50") && path.includes("answers_limit=50"))).toBe(true));
  });
});
