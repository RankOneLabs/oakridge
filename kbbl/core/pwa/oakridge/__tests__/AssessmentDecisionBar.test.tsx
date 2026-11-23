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
        item_sources: [{ item: "item-1", proposal_key: "review-note", instruction: "Update the draft" }] }}
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
