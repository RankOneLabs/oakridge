// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeScopeHistory, makeScopeTransition } from "../__fixtures__/read-models";
import { OperatorHistoryPane } from "../views/OperatorHistoryPane";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client },
    createElement(OperatorHistoryPane, { runId: "run/one", scopeId: "scope/one", schemas: [] })));
}

describe("authority scope history", () => {
  test("shows committed transitions in the authority's newest-first order", async () => {
    const history = makeScopeHistory({ transitions: [
      makeScopeTransition({ id: "transition-12", version: 12 }),
      makeScopeTransition({ id: "transition-10", version: 10 }),
    ] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(history)));
    renderHistory();
    await screen.findByText(/Version 12/);
    const pane = screen.getByTestId("operator-history-pane");
    expect(within(pane).getAllByRole("listitem").map((item) => item.textContent?.match(/Version (\d+)/)?.[1]))
      .toEqual(["12", "10"]);
  });

  test("bounds the history request to the selected run and scope", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json(makeScopeHistory()));
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    await screen.findByText("No transitions yet.");
    expect(fetch.mock.calls[0]?.[0]).toBe("/oakridge/api/api/runs/run%2Fone/scopes/scope%2Fone/history");
  });
});
