import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AssessmentDecisionBar } from "../components/organisms/AssessmentDecisionBar";
import type { ParkedGate } from "../artifact-types";

afterEach(() => vi.restoreAllMocks());

test("approving submits the chosen rejection without composing feedback artifacts", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ kind: "committed" }));
  const gate: ParkedGate = {
    id: "gate", gate_type: "artifact_approval", gate_step: "reading_desk", run_id: "run", stage_name: "drafting",
    unit_id: "edition", artifact_revision_id: "appraisal:1", worktree: null,
    run_state: "active", actionable: true, resume_actions: [], offered_decisions: ["endorse"],
    decision_definitions: [{ key: "endorse", label: "Endorse folio", payload_schema: "{}", operation: "approve_assessment",
      assessment: "appraisal", fields: [], submit: { kind: "review", review: "reading_desk", decision: "endorse", effect: "approve", target_revision_id: "appraisal:1" } }],
  };
  const onRecorded = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}>
    <AssessmentDecisionBar address={{ run: "run", unit: "run/edition", artifact: "appraisal" }} assessed="manuscript:1" gate={gate}
      status={{ assessment_artifact: "appraisal", assessment_revision: "appraisal:1", unit: "run/edition", approval: { kind: "pending" },
        unresolved_proposals: ["item-1"], items: [{ item: "item-1", assignments: [] }],
        item_sources: [{ item: "item-1", origin: "proposal", proposal_key: "review-note", instruction: "Update the draft" }] }}
      workers={[{ key: "scribe", label: "Scribe", kind: "agent" }]}
      paths={[[{ kind: "field", value: "remarks" }, { kind: "each" }]]}
      body={{ remarks: [{ key: "review-note", instruction: "Update the draft" }] }} onRecorded={onRecorded} />
  </QueryClientProvider>);
  fireEvent.change(screen.getByLabelText("Rejection reason"), { target: { value: "Already addressed" } });
  fireEvent.click(screen.getByRole("button", { name: "Endorse folio" }));
  await waitFor(() => expect(onRecorded).toHaveBeenCalledOnce());
  const [url, init] = fetch.mock.calls[0];
  expect(String(url)).toContain("/reviews/reading_desk/decide");
  const { request_id, ...body } = JSON.parse(String(init?.body));
  expect(typeof request_id).toBe("string");
  expect(body).toEqual({ decision: "endorse", target: "appraisal:1", assessed_revision: "manuscript:1",
    dispositions: [{ kind: "reject", item: "item-1", reason: "Already addressed" }] });
});

test.each([
  { operation: "dispatch_feedback" as const, origin: "proposal" as const, fresh: true, target: "draft:2" },
  { operation: "dispatch_feedback" as const, origin: "proposal" as const, fresh: false, target: "draft:2" },
  { operation: "direct_correction" as const, origin: "operator" as const, fresh: true, target: "appraisal:2" },
])("authorizes and submits $operation for $origin (fresh=$fresh) using the distinct target revisions", async ({ operation, origin, fresh, target }) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ kind: "committed" }));
  const onRecorded = vi.fn();
  const gate: ParkedGate = {
    id: "gate", gate_type: "artifact_approval", gate_step: "desk", run_id: "run", stage_name: "writing",
    unit_id: "edition", artifact_revision_id: "appraisal:2", worktree: null, run_state: "active", actionable: true,
    resume_actions: [], offered_decisions: ["revise"], decision_definitions: [{
      key: "revise", label: "Return selected work", operation, payload_schema: "{}", assessment: "appraisal", fields: [],
      submit: { kind: "review", review: "desk", decision: "revise", effect: "request_changes", target_revision_id: target },
    }],
  };
  const unresolved = fresh && origin === "proposal";
  render(<QueryClientProvider client={new QueryClient()}>
    <AssessmentDecisionBar address={{ run: "run", unit: "edition", artifact: "appraisal" }} assessed="draft:2" gate={gate}
      status={{ assessment_artifact: "appraisal", assessment_revision: "appraisal:2", unit: "edition", approval: { kind: "pending" },
        unresolved_proposals: unresolved ? ["item"] : [], items: [{ item: "item", assignments: fresh ? [] : [
          { assignment: "assign", current_round: "round", recipient: "scribe", progress: "returned_for_update" }] }],
        item_sources: [{ item: "item", origin, proposal_key: unresolved ? "note" : null, instruction: "Revise" }] }}
      workers={[{ key: "scribe", label: "Scribe", kind: "agent" }]} paths={[]} body={{}} onRecorded={onRecorded} />
  </QueryClientProvider>);
  if (unresolved) fireEvent.change(screen.getByLabelText("Disposition"), { target: { value: "dispatch" } });
  fireEvent.change(screen.getByLabelText("Instruction"), { target: { value: "Update the text" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Scribe" }));
  fireEvent.click(screen.getByRole("button", { name: "Authorize dispatch" }));
  await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Return selected work" }));
  await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(2));
  const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies).toMatchObject([
    { item: "item", target_revision: target, recipients: ["scribe"], instruction: "Update the text" },
    { target: "appraisal:2", assessed_revision: "draft:2", dispositions: [{ kind: "dispatch", item: "item", recipients: ["scribe"], instruction: "Update the text" }] },
  ]);
});

function withheldGate(operation: "approve_assessment" | "dispatch_feedback", effect: "approve" | "request_changes"): ParkedGate {
  return {
    id: "gate", gate_type: "artifact_approval", gate_step: "desk", run_id: "run", stage_name: "writing",
    unit_id: "edition", artifact_revision_id: "appraisal:1", worktree: null, run_state: "active", actionable: true,
    resume_actions: [], offered_decisions: ["decide"], decision_definitions: [{
      key: "decide", label: "Record the desk decision", operation, payload_schema: "{}", assessment: "appraisal", fields: [],
      is_available: false, disabled_reason: "The folio is still with the scribe.",
      submit: { kind: "review", review: "desk", decision: "decide", effect, target_revision_id: "draft:1" },
    }],
  };
}

function renderWithheld(gate: ParkedGate) {
  render(<QueryClientProvider client={new QueryClient()}>
    <AssessmentDecisionBar address={{ run: "run", unit: "edition", artifact: "appraisal" }} assessed="draft:1" gate={gate}
      status={{ assessment_artifact: "appraisal", assessment_revision: "appraisal:1", unit: "edition", approval: { kind: "pending" },
        unresolved_proposals: ["item"], items: [{ item: "item", assignments: [] }],
        item_sources: [{ item: "item", origin: "proposal", proposal_key: "note", instruction: "Revise" }] }}
      workers={[{ key: "scribe", label: "Scribe", kind: "agent" }]} paths={[]} body={{}} onRecorded={vi.fn()} />
  </QueryClientProvider>);
}

test("a withheld decision stays visible, disabled, beside the server's reason", () => {
  renderWithheld(withheldGate("approve_assessment", "approve"));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Record the desk decision" }).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe(" — The folio is still with the scribe.");
});

test("a withheld dispatch keeps its authorize control, disabled, beside the server's reason", () => {
  renderWithheld(withheldGate("dispatch_feedback", "request_changes"));
  fireEvent.change(screen.getByLabelText("Disposition"), { target: { value: "dispatch" } });
  fireEvent.change(screen.getByLabelText("Instruction"), { target: { value: "Update the text" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Authorize dispatch" }).disabled).toBe(true);
  expect(screen.queryByRole("checkbox", { name: "Scribe" })).toBeNull();
  expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual([" — The folio is still with the scribe.", " — The folio is still with the scribe."]);
});
