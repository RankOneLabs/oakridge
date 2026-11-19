import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { parkedBlockerUnits } from "../__fixtures__/read-models";
import { reviewToGates } from "../adapters/gates";
import { selectBlockerGroups } from "../lib/blocker";
import { BlockerGroupPanel } from "../components/organisms/BlockerGroupPanel";
import type { GateResumeRequest } from "../artifact-types";

const resumeGate = vi.fn<(gateId: string, request: GateResumeRequest) => Promise<unknown>>();
vi.mock("../client", () => ({ resumeGate: (gateId: string, request: GateResumeRequest) => resumeGate(gateId, request) }));
afterEach(() => { cleanup(); resumeGate.mockReset(); });

const units = parkedBlockerUnits(["A", "B", "C"]);
const [group] = selectBlockerGroups(units.flatMap((unit) => { const gates = reviewToGates(unit); return gates.ok ? gates.value : []; }));
function display() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><BlockerGroupPanel group={group} /></QueryClientProvider>);
}
function answer(choice: string) {
  fireEvent.click(screen.getByRole("button", { name: "Clarify" }));
  fireEvent.click(screen.getByRole("button", { name: choice }));
  fireEvent.click(screen.getByRole("button", { name: /^Send answer/ }));
}

test("one answer is sent to every parked unit's blocker", async () => {
  resumeGate.mockResolvedValue({});
  display();
  answer("Compact");
  await screen.findByText("Answer sent to all 3 units.");
  expect(resumeGate.mock.calls.map(([gateId, request]) => [gateId, request.artifact_revision_id.endsWith(`run/brief/${group.gates.find((gate) => gate.id === gateId)?.unit_id}:blocker:1`), request.action, request.feedback]))
    .toEqual(group.gates.map((gate) => [gate.id, true, "clarify", "Compact"]));
});

test("a unit that refuses the answer is retried alone", async () => {
  resumeGate.mockImplementation(async (gateId) => { if (gateId === group.gates[1].id) throw new Error("revision moved"); return {}; });
  display();
  answer("Compact");
  await screen.findByText("B: not sent — revision moved");
  resumeGate.mockReset();
  resumeGate.mockResolvedValue({});
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
  await waitFor(() => expect(resumeGate.mock.calls.map(([gateId]) => gateId)).toEqual([group.gates[1].id]));
});
