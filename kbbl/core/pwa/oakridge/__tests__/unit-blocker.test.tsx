import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import fixture from "../__fixtures__/parked-blocker-unit.json";
import { UnitBlocker } from "../components/organisms/StageOverview";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";

afterEach(cleanup);
const unitA = fixture as unknown as OperatorUnitView;
const unitB: OperatorUnitView = { ...unitA, unit_id: "run/brief/B", collection_key: "B",
  decisions: unitA.decisions.map((decision) => decision.submit.kind === "review" ? { ...decision, submit: { ...decision.submit, target_revision_id: "run/brief/B:blocker:1" } } : decision) };
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const show = (unit: OperatorUnitView) => <QueryClientProvider client={client}><UnitBlocker unit={unit} /></QueryClientProvider>;

test("a pane moved to another blocked unit starts with an empty answer", () => {
  const view = render(show(unitA));
  fireEvent.change(screen.getByLabelText("Your answer (free text)"), { target: { value: "Draft for A" } });
  view.rerender(show(unitB));
  expect((screen.getByLabelText("Your answer (free text)") as HTMLTextAreaElement).value).toBe("");
});
