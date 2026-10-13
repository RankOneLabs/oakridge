// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeUnitHistory, makeEventHistory } from "../__fixtures__/read-models";
import { OperatorHistoryPane } from "../views/OperatorHistoryPane";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client },
    createElement(OperatorHistoryPane, { runId: "run/one", unitId: "unit/one" })));
}

describe("unit history", () => {
  test("shows committed events in the authority's newest-first order, with their writers", async () => {
    const history = makeUnitHistory({ events: [
      makeEventHistory({ id: "event-12", event: { kind: "retry_requested", unit: "unit/one", worker: "writer" }, writer: { kind: "operator", subject: "operator" } }),
      makeEventHistory({ id: "event-10", event: { kind: "worker_started", action: "writer:1" }, writer: { kind: "executor", attempt: "writer:1" } }),
    ] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(history)));
    renderHistory();
    await screen.findByText(/retry_requested/);
    const pane = screen.getByTestId("operator-history-pane");
    expect(within(pane).getAllByRole("listitem").map((item) => item.textContent?.split(" · ").slice(0, 2).join(" · ")))
      .toEqual(["retry_requested · operator", "worker_started · executor"]);
  });

  test("bounds the history request to the selected run and unit", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json(makeUnitHistory()));
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    await screen.findByText("No events yet.");
    expect(fetch.mock.calls[0]?.[0]).toBe("/oakridge/api/api/runs/run%2Fone/units/unit%2Fone/history");
  });
});
