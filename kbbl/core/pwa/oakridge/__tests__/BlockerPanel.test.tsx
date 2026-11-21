import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { blockerUnit } from "../__fixtures__/read-models";
import fixture from "../__fixtures__/parked-blocker-unit.json";
import { BlockerPanel } from "../components/organisms/BlockerPanel";
import { reviewToGates } from "../adapters/gates";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { invalidateCachedRunUnits } from "../client";
const unit = fixture as unknown as OperatorUnitView;
const gates = reviewToGates(unit);
if (!gates.ok || !unit.blocker) throw new Error("blocker fixture");
const gate = gates.value[0], blocker = unit.blocker;
afterEach(() => { cleanup(); vi.restoreAllMocks(); invalidateCachedRunUnits(null); });
function display(value = gate) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><BlockerPanel gate={value} blocker={blocker} /></QueryClientProvider>);
}
test("blocker shows suggested choices and its full history in chronological order", () => {
  display();
  expect(screen.getByRole("button", { name: "Compact" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Expanded" })).toBeTruthy();
  const history = screen.getAllByRole("list").find((list) => list.tagName === "OL");
  expect(history?.textContent).toMatch(/blocker:1[\s\S]*Explain the width tradeoff[\s\S]*blocker:2/);
  expect(screen.getByText(/Operator steve/)).toBeTruthy();
});
test("blocker controls display the core decision labels", () => {
  const projected = reviewToGates(blockerUnit());
  if (!projected.ok || !projected.value[0]) throw new Error("blocker gate absent");
  display(projected.value[0]);
  for (const label of ["Clarify", "Discuss", "Override"]) {
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  }
});
test("each blocker revision names the worker attempt that published it", () => {
  display();
  const history = screen.getAllByRole("list").find((list) => list.tagName === "OL");
  expect(history?.textContent).toMatch(/blocker:1 · writer \(attempt 1, session session-1\)/);
  expect(history?.textContent).not.toMatch(/not projected/);
});
test.each(["Clarify", "Override — proceed anyway", "Discuss"])("%s posts free text through the existing decision route", async (label) => {
  const posts: { decision: string; payload: { answer: string } }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (init?.method === "POST") {
      expect(String(input)).toContain("/reviews/blocker_review/decide");
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ kind: "committed", run_id: unit.run_id, event_id: "answer" });
    }
    return Response.json(unit);
  });
  display();
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.change(screen.getByLabelText("Your answer (free text)"), { target: { value: "A different choice with detailed reasoning" } });
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ decision: label === "Discuss" ? "discuss" : label === "Clarify" ? "clarify" : "override", payload: { answer: "A different choice with detailed reasoning" } });
});
test("a refused answer preserves the typed draft", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => init?.method === "POST"
    ? Response.json({ error: "Stale blocker" }, { status: 409 }) : Response.json(unit));
  display();
  fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
  fireEvent.change(screen.getByLabelText("Your answer (free text)"), { target: { value: "Keep this answer" } });
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
  await screen.findByRole("alert");
  expect((screen.getByLabelText("Your answer (free text)") as HTMLTextAreaElement).value).toBe("Keep this answer");
});
test("projected guards disable decisions with their stated reason", () => {
  display({ ...gate, decision_definitions: gate.decision_definitions?.map((definition) => ({ ...definition, is_available: definition.key !== "override", disabled_reason: definition.key === "override" ? "Open blocking findings" : null })) });
  expect((screen.getByRole("button", { name: "Override — proceed anyway" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Open blocking findings/)).toBeTruthy();
});
