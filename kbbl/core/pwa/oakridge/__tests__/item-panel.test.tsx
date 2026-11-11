import { json, panel, world, wrap } from "./item-panel-harness";
import plan from "../lib/__fixtures__/id-linked-plan.json";
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { acknowledged, id, IMPLEMENTATION, INTEGRATION, ANALYSIS, item, itemStatus, machine, OCCURRENCE, paged, reviewerAnswer, supportQuestion, taskComposite } from "../__fixtures__/grading";
import { compositeId } from "../adapters/core";
import { AssessmentViewer } from "../components/molecules/AssessmentViewer";
import { SpecAnalysisViewer } from "../components/molecules/SpecAnalysisViewer";
import { FinalIntegrationPanel } from "../components/organisms/FinalIntegrationPanel";
import { ItemPanel } from "../components/organisms/ItemPanel";
import { RunGradingSection } from "../components/organisms/RunGradingSection";
import { TaskPanel } from "../components/organisms/TaskPanel";
import type { ObservationEvidenceReference } from "../grading-contracts/grading/evidence";
import type { ObservationGradeObservationId } from "../grading-contracts/domain/identity";
import type { ObservationCompositeRead } from "../grading-contracts/grading/item-reads";
import { parseAssessment } from "../lib/assessment";
import { useGradingVisibility } from "../state/gradingVisibility";
import type { EpicWorkflowProfile } from "../run-types";

it.each(["task", "acceptance_entry"])("shows a %s's captured text and explicit spec-task identity", async (item_kind) => {
  const open = vi.fn();
  world.status = itemStatus([supportQuestion()], { item: item(IMPLEMENTATION, { item_kind,
    selected_value: item_kind === "task" ? { id: "T7", description: "Define organizations" } : { id: "T7", text: "Expose organization reads" } }), links: paged([]) });
  panel(open);
  const task = await screen.findByTestId("or-item-spec-task");
  expect(task.textContent).toBe("T7");
  expect(screen.getByText(item_kind === "task" ? "Define organizations" : "Expose organization reads")).toBeTruthy();
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
  for (const label of ["Id", "Description", "Status"]) expect(within(references[0]!).getByText(label)).toBeTruthy();
  expect(within(references[1]!).getByText("Commit sha")).toBeTruthy();
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
  expect(within(whole!).queryByText("Dependency order")).toBeNull();
  expect(within(cohort!).getByText("Files in scope")).toBeTruthy();
  fireEvent.click(within(whole!).getByRole("button", { name: "Show fields" }));
  expect(within(whole!).getByText("Dependency order")).toBeTruthy();
  expect(within(spec!).getByRole("button", { name: "Show fields" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(within(whole!).getByRole("button", { name: "Hide fields" }));
  expect(within(whole!).queryByText("Dependency order")).toBeNull();
});
const documentText = () => document.body.textContent ?? "";
const ariaText = () => Array.from(document.querySelectorAll("[aria-label]")).map((element) => element.getAttribute("aria-label")).join(" ");
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
    world.status = itemStatus([supportQuestion({ question: { ...supportQuestion().question, question_id: id("finding.relevance"), allowed_values: ["relevant", "irrelevant", "unclear"] } })], {}, ANALYSIS);
    wrap(<ItemPanel runId="run-1" selection={ANALYSIS} onOpenTask={vi.fn()} />);
    expect((await screen.findAllByTestId("or-your-grade-choice")).map((input) => (input as HTMLInputElement).value)).toEqual(["relevant", "irrelevant", "unclear"]);
    expect(screen.getByTestId("or-item-question").textContent).toBe("Relevance");
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
    expect(references[0]!.textContent).toContain("oakridge src/a.ts:2-3 @ abc123");
    expect(references[1]!.textContent).toContain("Agent-reported");
  });
  it("a task link is navigation: it opens the task, and an unresolved one stays visible", async () => {
    const onOpenTask = vi.fn();
    panel(onOpenTask);
    const links = await screen.findAllByTestId("or-item-task-link");
    expect(links.map((link) => [link.textContent, link.getAttribute("data-link-state")])).toEqual([["T1", "resolved"], ["T404 (unresolved)", "unresolved"]]);
    fireEvent.click(links[1]!);
    expect(onOpenTask).toHaveBeenCalledWith("T404");
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

describe("saving", () => {
  const choose = async (index: number) => fireEvent.click((await screen.findAllByTestId("or-your-grade-choice"))[index]!);
  it("sends occurrence, question, submission id, answer and rationale, and no identity", async () => {
    panel();
    await choose(1);
    fireEvent.change(screen.getByTestId("or-your-grade-rationale"), { target: { value: "cited line disagrees" } });
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-saved");
    expect(world.sent).toEqual([{ task_id: null, question_id: id("assessment_finding.evidence_support"), question_version: "1", submission_id: expect.any(String), answer: "does_not_support", rationale: "cited line disagrees", corrects_observation_id: null }]);
    expect(world.paths.some((path) => path.startsWith(`/oakridge/observation/items/${encodeURIComponent(OCCURRENCE)}/answers`))).toBe(true);
  });
  it("says saved only after the acknowledgment arrives", async () => {
    let answer: (response: Response) => void = () => {};
    world.submit = () => new Promise<Response>((resolve) => { answer = resolve; });
    panel();
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-pending");
    expect(screen.queryByTestId("or-your-grade-saved")).toBeNull();
    answer(json(acknowledged("supports"), 201));
    expect((await screen.findByTestId("or-your-grade-saved")).textContent).toContain("supports");
  });
  it("a refusal and a lost reply never say saved, and each shows its reason", async () => {
    world.submit = () => json({ error: { code: "not_ready", message: "still waiting for a build" } }, 409);
    panel();
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    expect((await screen.findByTestId("or-your-grade-refused")).textContent).toContain("still waiting for a build");
    expect(screen.queryByTestId("or-your-grade-saved")).toBeNull();
    world.submit = () => { throw new Error("connection lost"); };
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    expect((await screen.findByTestId("or-your-grade-failed")).textContent).toContain("connection lost");
    expect(screen.queryByTestId("or-your-grade-saved")).toBeNull();
  });
  it("retrying after a lost reply reuses its submission id, and a changed answer takes a new one", async () => {
    world.submit = () => { throw new Error("connection lost"); };
    panel();
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-failed");
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await waitFor(() => expect(world.sent).toHaveLength(2));
    const [first, second] = world.sent as { submission_id: string }[];
    expect(second!.submission_id).toBe(first!.submission_id);
    await choose(1);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await waitFor(() => expect(world.sent).toHaveLength(3));
    expect((world.sent[2] as { submission_id: string }).submission_id).not.toBe(first!.submission_id);
  });
  it("a correction links the operator's current answer and keeps the earlier one listed", async () => {
    world.own = [reviewerAnswer("first", "does_not_support"), reviewerAnswer("second", "unclear", "oakridge-operator", { supersedes_observation_id: id<ObservationGradeObservationId>("first") })];
    panel();
    expect((await screen.findByTestId("or-your-grade-current")).textContent).toContain("unclear");
    expect(screen.getByTestId("or-your-grade-history").textContent).toContain("does not support");
    expect(screen.getByTestId("or-your-grade-submit").textContent).toBe("Correct your answer");
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-saved");
    expect(world.sent).toMatchObject([{ answer: "supports", corrects_observation_id: id("second") }]);
  });
  it("after another tab corrects first, a stale refusal reloads the operator's answers and the retry corrects the new one", async () => {
    world.own = [reviewerAnswer("first", "does_not_support")];
    world.submit = () => { world.own = [...world.own, reviewerAnswer("other-tab", "unclear", "oakridge-operator", { supersedes_observation_id: id<ObservationGradeObservationId>("first") })];
      return json({ error: { code: "stale_correction", message: "that answer has already been corrected" } }, 409); };
    panel();
    expect((await screen.findByTestId("or-your-grade-current")).textContent).toContain("does not support");
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-refused");
    expect(screen.getByTestId("or-your-grade-current").textContent).toContain("unclear");
    world.submit = () => json(acknowledged("supports"), 201);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-saved");
    expect(world.sent).toMatchObject([{ corrects_observation_id: id("first") }, { corrects_observation_id: id("other-tab") }]);
  });
  it("nothing can be edited while a submission is out", async () => {
    let answer: (response: Response) => void = () => {};
    world.submit = () => new Promise<Response>((resolve) => { answer = resolve; });
    panel();
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-pending");
    expect(screen.getAllByTestId("or-your-grade-choice").every((input) => (input as HTMLInputElement).disabled)).toBe(true);
    expect((screen.getByTestId("or-your-grade-rationale") as HTMLTextAreaElement).disabled).toBe(true);
    answer(json(acknowledged("supports"), 201));
    await screen.findByTestId("or-your-grade-saved");
    expect((screen.getByTestId("or-your-grade-rationale") as HTMLTextAreaElement).disabled).toBe(false);
  });
  it("an explanation alone can be corrected, starting from the stored one", async () => {
    world.own = [reviewerAnswer("first", "unclear", "oakridge-operator", { rationale: "line 4" })];
    panel();
    await screen.findByTestId("or-your-grade-current");
    const rationale = screen.getByTestId("or-your-grade-rationale") as HTMLTextAreaElement;
    expect(rationale.value).toBe("line 4");
    expect((screen.getByTestId("or-your-grade-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(rationale, { target: { value: "line 5" } });
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-saved");
    expect(world.sent).toMatchObject([{ answer: "unclear", rationale: "line 5", corrects_observation_id: id("first") }]);
  });
});

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
    expect(within(stages[0]!).getByTestId("or-task-coverage-gap")).toBeTruthy();
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
    expect((await screen.findAllByTestId("or-stage-findings-unavailable")).length).toBe(3);
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
    fireEvent.click(buttons[0]!);
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
    fireEvent.click(buttons[0]!);
    expect(onOpenItem).toHaveBeenCalledWith({ source_revision_id: IMPLEMENTATION.source_revision_id, item_path: "/findings/1" });
  });
  it("integration review: an integration finding opens with no build subject or brief", () => {
    const onOpenItem = vi.fn();
    wrap(<AssessmentViewer assessment={assessment()} brief={missing} result={missing} cohortLabel="final" isIntegration source={{ revision_id: revisionId("run-1/integration/final", "assessment", INTEGRATION.source_revision_id) }} onOpenItem={onOpenItem} />);
    fireEvent.click(screen.getAllByTestId("or-grade-item")[0]!);
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
    fireEvent.click((await screen.findAllByTestId("or-grade-item"))[0]!);
    expect(onOpenItem).toHaveBeenCalledWith(ANALYSIS);
  });
});

it("passes the selected task through status, lineage, own-answer reads and submission", async () => {
  const task_id = id<import("../grading-contracts/domain/identity").ObservationLogicalItemId>("task-3");
  const question = supportQuestion({ task_id });
  world.status = itemStatus([{ ...question, evidence: { ...question.evidence, task_id } }]);
  wrap(<ItemPanel runId="run-1" selection={{ ...IMPLEMENTATION, task_id }} onOpenTask={vi.fn()} />);
  const choices = await screen.findAllByTestId("or-your-grade-choice");
  fireEvent.click(choices[0]!);
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
