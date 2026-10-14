import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RunWorkspace } from "../components/organisms/RunWorkspace";
import { afterEach, expect, test, vi } from "vitest";
import { OperatorDecisionForm } from "../components/organisms/OperatorDecisionForm";
import type { OperatorSchema } from "../operator-contracts";
import { makeDecision, makeRunUnitSummary, makeRunView, makeUnitView } from "../__fixtures__/read-models";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const noteSchemas = (min_length: number): readonly OperatorSchema[] => [
  { key: "text", shape: { kind: "string", min_length, max_length: 100 } },
  { key: "payload", shape: { kind: "record", fields: [{ key: "note", schema: "text" }] } },
];
const noteDecision = makeDecision({ key: "act", label: "Act", payload_schema: "payload" });
const noteUnit = makeUnitView({ run_id: "run-one", unit_id: "unit-one", unit_key: "root", label: "Root", decisions: [noteDecision] });
const committed = () => Response.json({ kind: "committed", run_id: "run-one", event_id: "event-1" });
const isDecide = (url: string, init?: RequestInit): boolean => url.endsWith("/decide") && init?.method === "POST";

test("a string that admits an empty value submits as the empty string", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => committed());
  vi.stubGlobal("fetch", fetch);
  render(<QueryClientProvider client={new QueryClient()}><OperatorDecisionForm unit={noteUnit} decision={noteDecision} schemas={noteSchemas(0)} onRefresh={() => undefined} /></QueryClientProvider>);
  expect(screen.getByLabelText<HTMLTextAreaElement>("note").required).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Submit Act" }));
  await screen.findByText("Decision accepted.");
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).payload).toEqual({ note: "" });
});

test("a string with a positive minimum is refused empty and never sent", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<QueryClientProvider client={new QueryClient()}><OperatorDecisionForm unit={noteUnit} decision={noteDecision} schemas={noteSchemas(1)} onRefresh={() => undefined} /></QueryClientProvider>);
  fireEvent.submit(screen.getByTestId("operator-command-form"));
  expect((await screen.findByRole("alert")).textContent).toMatch(/note is required/);
  expect(fetch).not.toHaveBeenCalled();
});

/** A run whose root unit offers one decision taking one free-text field; `refreshes` counts unit reads. */
function serveRun(onDecision: () => Response = () => Response.json({ error: "unexpected" }, { status: 500 })) {
  const state = { refreshes: 0 };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (isDecide(url, init)) return onDecision();
    if (url.endsWith("/runs/run-one")) return Response.json(makeRunView({ run_id: "run-one", units: [makeRunUnitSummary({ unit_id: "unit-one", unit_key: "root", label: "Root", asks: ["act"] })] }));
    if (url.endsWith("/definitions/bundle-1")) return Response.json({ bundle: { root: "root", schemas: noteSchemas(0), units: [] } });
    if (url.endsWith("/history")) return Response.json({ unit_id: "unit-one", events: [], next_cursor: null });
    state.refreshes += 1;
    return Response.json(url.endsWith("/units") ? [noteUnit] : noteUnit);
  });
  vi.stubGlobal("fetch", fetch);
  return { state, fetch };
}
const mountRun = () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><RunWorkspace runId="run-one" routePane={null} unitId={null} onBack={() => undefined} /></QueryClientProvider>);
  return cache;
};

test("typed input survives a background refresh of the unit", async () => {
  const { state } = serveRun();
  const cache = mountRun();
  fireEvent.change(await screen.findByLabelText("note"), { target: { value: "half-written" } });
  await cache.invalidateQueries({ queryKey: ["operator", "run-one"] });
  await waitFor(() => expect(state.refreshes).toBeGreaterThan(1));
  expect(screen.getByLabelText<HTMLTextAreaElement>("note").value).toBe("half-written");
});

test("a rejection stays visible, with the typed input, after the refresh it triggers", async () => {
  const { state } = serveRun(() => Response.json({ kind: "rejected", reason: "review is not open" }, { status: 409 }));
  mountRun();
  fireEvent.change(await screen.findByLabelText("note"), { target: { value: "my words" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit Act" }));
  await waitFor(() => expect(state.refreshes).toBeGreaterThan(1));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Your input is kept/);
  expect(screen.getByLabelText<HTMLTextAreaElement>("note").value).toBe("my words");
});

test("an accepted decision's input is not restored as a draft after the refresh", async () => {
  const { state } = serveRun(committed);
  mountRun();
  fireEvent.change(await screen.findByLabelText("note"), { target: { value: "already sent" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit Act" }));
  await screen.findByText("Decision accepted.");
  await waitFor(() => expect(state.refreshes).toBeGreaterThan(1));
  expect(Object.keys(localStorage).filter((key) => localStorage.getItem(key)?.includes("already sent"))).toEqual([]);
});
