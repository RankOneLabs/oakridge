import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { makeDecision, makeDecisionSubmission, makeRunUnitSummary, makeRunView, makeUnitView } from "../__fixtures__/read-models";
import { RunWorkspace } from "../components/organisms/RunWorkspace";
import { PlanGraph } from "../components/molecules/PlanGraph";
import { selectPendingDecisionsForRecovery } from "../lib/run-attention";
import { operatorDraftIdentity, savePendingDecision } from "../lib/operator-drafts";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const submission = makeDecisionSubmission({ request_id: "stable-request" });

test("a pending decision the unit no longer offers is recovered, once", () => {
  const candidates = (attempted: ReadonlySet<string>) => selectPendingDecisionsForRecovery({ pending: [submission],
    units: [makeUnitView()], attempted, inFlight: new Set() });
  expect([candidates(new Set()), candidates(new Set([operatorDraftIdentity(submission)]))]).toEqual([[submission], []]);
});

test("a pending decision still offered is left to its form", () => {
  expect(selectPendingDecisionsForRecovery({ pending: [submission], units: [makeUnitView({ decisions: [makeDecision()] })],
    attempted: new Set(), inFlight: new Set() })).toEqual([]);
});

/** Serves a run whose unit offers nothing, so a pending decision on it is the run view's to recover. */
const workspaceFetch = (posts: string[], answer: () => Response) => vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === "POST") { posts.push(JSON.parse(String(init.body)).request_id as string); return answer(); }
  if (url.endsWith("/runs/run-1")) return Response.json(makeRunView({ units: [makeRunUnitSummary()] }));
  if (url.endsWith("/definitions/bundle-1")) return Response.json({ bundle: { root: "development", schemas: [], units: [] } });
  if (url.endsWith("/history")) return Response.json({ unit_id: "unit-1", events: [], next_cursor: null });
  if (url.endsWith("/units")) return Response.json([makeUnitView()]);
  throw new Error(url);
});
const renderWorkspace = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <RunWorkspace runId="run-1" routePane={null} unitId="unit-1" onBack={() => undefined} /></QueryClientProvider>);

test("an uncertain decision is resubmitted under its retained request id when the run is opened again", async () => {
  savePendingDecision(submission);
  const posts: string[] = [];
  vi.stubGlobal("fetch", workspaceFetch(posts, () => posts.length === 1 ? Response.json({ detail: "uncertain" }, { status: 503 })
    : Response.json({ kind: "committed", run_id: "run-1", event_id: "event-1" })));
  const first = renderWorkspace();
  await screen.findByText(/approve: uncertain/);
  first.unmount();
  renderWorkspace();
  await screen.findByText(/Receipt recovered for approve/);
  expect(posts).toEqual(["stable-request", "stable-request"]);
});

test("a failed selected-unit request shows the failure instead of loading forever", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/runs/run-1")) return Response.json(makeRunView({ units: [makeRunUnitSummary()] }));
    if (url.endsWith("/definitions/bundle-1")) return Response.json({ bundle: { root: "development", schemas: [], units: [] } });
    if (url.endsWith("/units")) return Response.json({ detail: "projection unavailable" }, { status: 503 });
    throw new Error(url);
  }));
  renderWorkspace();
  expect((await screen.findByText(/Could not load unit:.*projection unavailable/)).getAttribute("role")).toBe("alert");
});

test("graph nodes activate with Space", () => {
  const onSelect = vi.fn();
  render(<PlanGraph layout={{ width: 320, height: 150, edges: [], nodes: [
    { id: "cohort-1", title: "Build", depends_on: [], x: 24, y: 36, cohort: { id: "cohort-1", title: "Build" } },
  ] }} selectedId={null} onSelect={onSelect} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "cohort-1 Build" }), { key: " " });
  expect(onSelect).toHaveBeenCalledWith("cohort-1");
});
