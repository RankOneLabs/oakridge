import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { blockerUnit } from "../__fixtures__/read-models";
import { reviewToGates } from "../adapters/gates";
import { GateDecisionActions } from "../components/organisms/GateDecisionActions";
import { invalidateCachedRunUnits } from "../client";

afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); });

it.each(["clarify", "discuss", "override"])("submits a blocker %s answer through the real gate client", async (action) => {
  const unit = blockerUnit();
  const gates = reviewToGates(unit);
  if (!gates.ok || !gates.value[0]) throw new Error("blocker gate absent");
  const requests: { decision: string; target: string; payload: { answer: string } }[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (init?.method === "POST") {
      expect(String(input)).toContain("/reviews/blocker_review/decide");
      requests.push(JSON.parse(String(init.body)));
      return Response.json({ kind: "committed", run_id: unit.run_id, event_id: "answered" });
    }
    return Response.json(unit);
  });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><GateDecisionActions gate={gates.value[0]} /></QueryClientProvider>);

  expect(gates.value[0].resume_actions).toEqual(["clarify", "discuss", "override"]);
  fireEvent.click(screen.getByTestId(`or-decision-${action}`));
  expect(fetch).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Use the revised contract" } });
  fireEvent.click(screen.getByRole("button", { name: "Send answer" }));

  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({ decision: action, target: "blocker-revision", payload: { answer: "Use the revised contract" } });
  expect(await screen.findByText("Answer sent to the worker.")).toBeTruthy();
});
