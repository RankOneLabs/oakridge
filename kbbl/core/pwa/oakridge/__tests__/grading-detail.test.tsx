import type { ObservationAnswerRead, ObservationUnresolvedReferenceRead } from "../grading-contracts/grading/item-reads";
import { documentText, json, panel, world, wrap } from "./item-panel-harness";
import { expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { id, IMPLEMENTATION, itemStatus, machineAnswer, OCCURRENCE, paged, supportQuestion } from "../__fixtures__/grading";
import type { ObservationEvidenceReference } from "../grading-contracts/grading/evidence";
import type { ObservationEvaluatorDefinition } from "../grading-contracts/grading/evaluator";
import { selectEvaluatorDefinitionIds, selectGradingEvidence, selectUnresolvedTaskAssociations } from "../lib/grading-detail";
import { ShowAutomaticGrades } from "../components/organisms/ShowAutomaticGrades";
import { ItemPanel } from "../components/organisms/ItemPanel";

const references: ObservationEvidenceReference[] = [
  { source: "revision", ref: "reported-name-is-irrelevant", revision_id: id("exact-old-revision"), item_path: "/findings/2", content: "frozen artifact content" },
  { source: "run_input", ref: "launch", run_id: id("run-1"), input_path: "/spec", content: "frozen run input" },
  { source: "repository", ref: "reported-name", repository_key: "oakridge", path: "src/test.ts", commit_sha: "recorded-commit", line_range: null, is_absent: false, is_binary: false, byte_size: null, content: "retrieved file content" },
  { source: "reported", ref: "retrieved-name", reported_by: "agent", revision_id: id("report-revision"), item_path: "/evidence/1", content: "agent reported content" },
];
const definition: ObservationEvaluatorDefinition = { evaluator_definition_id: "jev", kind: "model", backend_kind: "pinned-runner", provider: "fixture", model: "pinned-model", prompt_digest: "pinned-prompt", instruction_text: "Pinned historical instructions: inspect the exact cited revision.", config_digest: "old-config", runtime_revision: "old-runtime", cost_metadata: null, seed: null, attempt_controls: null };
function withDefinitions(status = 200) {
  const base = vi.mocked(globalThis.fetch).getMockImplementation();
  if (!base) throw new Error("Grading fixture requires the item-panel fetch harness");
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    if (String(input).includes("/evaluator-definitions/")) {
      world.paths.push(String(input));
      const pathId = String(input).split("/").at(-1);
      if (!pathId) throw new Error("Evaluator fixture requires a definition id in the request path");
      const evaluatorId = decodeURIComponent(pathId);
      return status === 404 ? json({ error: { code: "not_found" } }, 404) : json({ ...definition, evaluator_definition_id: evaluatorId });
    }
    return base(input, init);
  });
}
it("classifies evidence solely by recorded source and preserves exact frozen inspection content", () => {
  expect(references.map((reference) => {
    const detail = selectGradingEvidence(reference);
    return [detail.provenance, detail.provenance_label, detail.display.location, detail.inspection.content.value];
  })).toEqual([
    ["artifact_revision", "Independently retrieved", "exact-old-revision /findings/2", "frozen artifact content"],
    ["run_input", "Independently retrieved", "run-1 /spec", "frozen run input"],
    ["repository_file_at_commit", "Independently retrieved", "oakridge src/test.ts @ recorded-commit", "retrieved file content"],
    ["agent_reported", "Reported", "report-revision /evidence/1", "agent reported content"],
  ]);
});
it("makes all four provenance classes inspectable with their recorded locations and content", async () => {
  const question = supportQuestion();
  world.status = itemStatus([{ ...question, evidence: { ...question.evidence, references: paged(references) } }]);
  panel();
  const rows = await screen.findAllByTestId("or-item-evidence-reference");
  expect(rows.map((row) => row.getAttribute("data-provenance"))).toEqual(["artifact_revision", "run_input", "repository_file_at_commit", "agent_reported"]);
  for (const [index, reference] of references.entries()) {
    const row = rows[index];
    if (!row) throw new Error(`Evidence fixture requires a rendered reference at index ${index}`);
    expect(within(row).getByText(index === 3 ? "Reported" : "Independently retrieved")).toBeTruthy();
    expect(row.querySelector(`[aria-label="Evidence content: ${reference.ref}"]`)?.textContent).toContain(String(reference.content));
  }
});
it("shows pinned evaluator instructions, runner, model, comments, rationale, status and historical answers", async () => {
  const historical: ObservationAnswerRead = { ...machineAnswer("supports"), observation_id: id("historical-answer"), grader: { kind: "machine" as const, evaluator_definition_id: id("historical-evaluator"), backend_kind: "older", model: "older-model" }, comments: "historical comments", is_current: false };
  const question = supportQuestion({ superseded_answers: paged([historical]) });
  world.status = itemStatus([question]);
  withDefinitions();
  panel();
  fireEvent.click(await screen.findByTestId("or-item-reveal"));
  await screen.findAllByText(definition.instruction_text);
  expect(screen.getAllByText(/pinned-runner/).length).toBeGreaterThan(0);
  expect(screen.getAllByText("pinned-model").length).toBeGreaterThan(0);
  expect(screen.getByTestId("or-item-question-text").textContent).toContain(question.question.question_text);
  expect(screen.getByText("Selected subject")).toBeTruthy();
  expect(screen.getAllByText("machine rationale leak-marker").length).toBeGreaterThan(0);
  expect(screen.getByText("Comments: historical comments")).toBeTruthy();
  expect(screen.getByTestId("or-item-answer-history").textContent).toContain("supports");
  expect(screen.getByTestId("or-item-machine-status").getAttribute("data-state")).toBe("answered");
  expect(world.paths).toContain("/oakridge/observation/evaluator-definitions/historical-evaluator");
  expect(selectEvaluatorDefinitionIds(question)).toContain("historical-evaluator");
});
it("retains answers when their pinned evaluator definition returns 404", async () => {
  withDefinitions(404);
  panel();
  fireEvent.click(await screen.findByTestId("or-item-reveal"));
  await screen.findAllByText("Pinned evaluator definition unavailable (not retained).");
  expect(screen.getByTestId("or-item-answers").textContent).toContain("does not support");
});
it("ShowAutomaticGrades hides automatic answers and evaluator details and makes no hidden definition request", async () => {
  withDefinitions();
  wrap(<><ShowAutomaticGrades selections={[IMPLEMENTATION]} /><ItemPanel runId="run-1" selection={IMPLEMENTATION} onOpenTask={vi.fn()} /></>);
  await screen.findByTestId("or-item-panel");
  expect(documentText()).not.toContain(definition.instruction_text);
  expect(world.paths.some((path) => path.includes("evaluator-definitions"))).toBe(false);
  fireEvent.click(screen.getByTestId("or-show-automatic-grades"));
  await screen.findAllByText(definition.instruction_text);
  fireEvent.click(screen.getByTestId("or-show-automatic-grades"));
  expect(screen.queryByTestId("or-evaluator-definition")).toBeNull();
  expect(documentText()).not.toContain("machine rationale leak-marker");
  expect(documentText()).not.toContain(definition.instruction_text);
});
it("keeps resolved task navigation separate from unresolved recorded references", async () => {
  const onOpenTask = vi.fn();
  panel(onOpenTask);
  await screen.findByTestId("or-item-panel");
  await waitFor(() => expect(world.paths.some((path) => path.includes("/unresolved-task-references"))).toBe(true));
  expect(screen.getAllByTestId("or-item-unresolved-task")[0]?.textContent).toContain("logical_item:task:T404");
  expect(screen.queryByRole("button", { name: "T404 (unresolved)" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "T1" }));
  expect(onOpenTask).toHaveBeenCalledWith("T1");
  const row: ObservationUnresolvedReferenceRead = { item: { ...world.status.item, occurrence_id: id("another-item") }, relation_id: id("foreign"), unresolved_target_ref: "T1", evidence_ref: "same words, different subject" };
  expect(selectUnresolvedTaskAssociations({ occurrence_id: OCCURRENCE, links: [], unresolved: [row] })).toEqual([]);
});
