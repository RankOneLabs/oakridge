import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { GateDecisionActions } from "../components/organisms/GateDecisionActions";
import type { ParkedGate } from "../artifact-types";

const { resume } = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock("../client", async (load) => ({ ...(await load<typeof import("../client")>()), resumeGate: resume }));
afterEach(() => resume.mockReset());

const actions = [
  { key: "accept_with_citation", label: "Accept with citation" },
  { key: "accept_as_written", label: "Accept as written" },
];
const gate: ParkedGate = {
  id: "gate", gate_type: "artifact_approval", gate_step: "folio_desk", run_id: "run", stage_name: "drafting",
  unit_id: "edition", artifact_revision_id: "folio:1", reviewed_revision_id: "folio:1", worktree: null,
  run_state: "active", actionable: true, resume_actions: actions.map(({ key }) => key),
  offered_decisions: actions.map(({ key }) => key),
  decision_definitions: actions.map(({ key, label }) => ({
    key, label, operation: "plain", payload_schema: "{}", assessment: null, fields: [],
    submit: { kind: "review", review: "folio_desk", decision: key, effect: "approve", target_revision_id: "folio:1" },
  })),
};

test.each(actions)("the $label button submits only its declared key", async ({ key, label }) => {
  resume.mockResolvedValue({ gate_id: gate.id, resumed: true });
  render(<QueryClientProvider client={new QueryClient()}><GateDecisionActions gate={gate} /></QueryClientProvider>);
  expect(screen.getByRole("button", { name: "Accept with citation" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Accept as written" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));
  await waitFor(() => expect(resume).toHaveBeenCalledWith("gate", expect.objectContaining({ action: key })));
});
