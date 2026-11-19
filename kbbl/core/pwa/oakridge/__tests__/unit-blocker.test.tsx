import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { parkedBlockerUnitFor } from "../__fixtures__/read-models";
import { UnitBlocker } from "../components/organisms/StageOverview";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";

afterEach(cleanup);
const unitA = parkedBlockerUnitFor("A"), unitB = parkedBlockerUnitFor("B");
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const show = (unit: OperatorUnitView) => <QueryClientProvider client={client}><UnitBlocker unit={unit} /></QueryClientProvider>;

test("a pane moved to another blocked unit starts with an empty answer", () => {
  const view = render(show(unitA));
  fireEvent.change(screen.getByLabelText("Your answer (free text)"), { target: { value: "Draft for A" } });
  view.rerender(show(unitB));
  expect((screen.getByLabelText("Your answer (free text)") as HTMLTextAreaElement).value).toBe("");
});
