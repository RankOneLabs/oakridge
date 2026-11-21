import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { sampleRun } from "../__fixtures__/read-models";
import { OperatorActionsList } from "../components/molecules/OperatorActionsList";
import type { OperatorActionRow } from "../lib/operator-actions";
import { RunDetailView } from "../views/RunDetailView";

vi.mock("../components/organisms/RunWorkspace", () => ({ RunWorkspace: () => <div>Workspace</div> }));

it("shows the recorded actions with their context and no controls", () => {
  const edited: OperatorActionRow = {
    key: "decision:edit", disposition_label: "Edited", original_text: "Original instructions", final_text: "Revised instructions",
    source_label: "Item B1", assessment_revision_id: "assessment-1", review: "assessment_review",
    decision: "request_build_changes", actor_label: "reviewer", created_at: "2026-01-01T00:00:00Z",
  };
  const added: OperatorActionRow = { ...edited, key: "decision:add", disposition_label: "Added", original_text: null,
    final_text: "New instructions", source_label: "Finding F1" };
  render(<OperatorActionsList rows={[edited, added]} />);
  const section = screen.getByTestId("or-operator-actions");
  expect(within(section).getByRole("heading", { name: "Operator actions" })).toBeTruthy();
  const rows = within(section).getAllByTestId("or-operator-action");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Edited");
  expect(rows[0].textContent).toContain("Original instructions");
  expect(rows[0].textContent).toContain("Revised instructions");
  expect(rows[0].textContent).toContain("Item B1 · Assessment assessment-1");
  expect(rows[0].textContent).toContain("assessment_review / request_build_changes · reviewer");
  expect(rows[0].querySelector("time")?.dateTime).toBe(edited.created_at);
  expect(rows[1].textContent).toContain("Added");
  expect(rows[1].textContent).toContain("New instructions");
  expect(section.querySelectorAll("button, input")).toHaveLength(0);
});

it("omits the history section on the run detail view when history is empty", () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const run = { ...sampleRun, pr_integration: "none", operator_actions: [] };
  client.setQueryData(["oakridge", "operator-run", run.run_id], run);
  const view = render(<QueryClientProvider client={client}>
    <RunDetailView runId={run.run_id} routePane={null} onBack={() => {}} />
  </QueryClientProvider>);
  expect(screen.queryByTestId("or-operator-actions")).toBeNull();
  view.unmount();
  client.clear();
});
