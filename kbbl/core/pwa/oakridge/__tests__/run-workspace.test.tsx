import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  makeBuildResultFixture, makeDecision, makeDefinitionSummary, makeAttemptView, makeRunView,
  makeRunUnitSummary, makeUnitHistory, makeUnitView, makeUnitWithArtifact, makeInboxDecision, makeInboxPage,
} from "../__fixtures__/read-models";
import { RunWorkspace } from "../components/organisms/RunWorkspace";
import { RunListView } from "../views/RunListView";
import type { OperatorRunView, OperatorUnitView } from "../operator-contracts";
import type { ArtifactId } from "../../lib/ids";
import { invalidateRunDetail } from "../lib/operator-invalidation";
import { queryKeys } from "../queryKeys";

const result = makeBuildResultFixture({ summary: "Build completed" });
const unit = makeUnitWithArtifact({ body: result.body, artifact_key: "build_result",
  unit: { attempts: [makeAttemptView({ status: "succeeded" })] } });
const run = makeRunView({ units: [makeRunUnitSummary({ asks: ["approve"] })] });

function stubWorkspace(options: { readonly run?: OperatorRunView; readonly unit?: OperatorUnitView;
  readonly failed?: "run" | "unit" | "definition" | "attention" } = {}) {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/runs/run-1/inbox")) return options.failed === "attention"
      ? Response.json({ detail: "attention unavailable" }, { status: 503 }) : Response.json(makeInboxPage());
    if (url.endsWith("/runs/run-1")) return options.failed === "run"
      ? Response.json({ detail: "run unavailable" }, { status: 503 }) : Response.json(options.run ?? run);
    if (url.endsWith("/definitions/bundle-1")) return options.failed === "definition"
      ? Response.json({ detail: "definition unavailable" }, { status: 503 }) : Response.json(makeDefinitionSummary());
    if (url.endsWith("/units")) return options.failed === "unit"
      ? Response.json({ detail: "unit unavailable" }, { status: 503 }) : Response.json([options.unit ?? unit]);
    if (url.endsWith("/history")) return Response.json(makeUnitHistory());
    if (url.endsWith("/threads")) return Response.json([]);
    throw new Error(url);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function show(routePane: Parameters<typeof RunWorkspace>[0]["routePane"] = null,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={client}>
    <RunWorkspace runId="run-1" routePane={routePane} unitId="unit-1" onBack={() => undefined} />
  </QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, "", window.location.pathname); localStorage.clear(); });

it("shows run identity, unit progress, attempts, artifacts and overview", async () => {
  stubWorkspace();
  show();
  const header = await screen.findByTestId("or-run-identity");
  expect(header.textContent).toContain("run-1");
  expect(header.textContent).toContain("0/1 units complete");
  await waitFor(() => expect(screen.getByTestId("or-sidebar-sessions").textContent).toContain("author #1"));
  expect(screen.getByTestId("or-sidebar-artifacts").textContent).toContain("build_result");
  expect(screen.getByTestId("or-run-overview")).toBeTruthy();
});

it("keeps the digest-addressed definition cached across run refreshes", async () => {
  const fetch = stubWorkspace();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  show(null, client);
  const count = (suffix: string) => fetch.mock.calls.filter(([url]) => url.endsWith(suffix)).length;
  await waitFor(() => expect(count("/definitions/bundle-1")).toBe(1));
  invalidateRunDetail(client, "run-1");
  await waitFor(() => expect(count("/runs/run-1")).toBe(2));
  expect(count("/definitions/bundle-1")).toBe(1);
});

it("an archived run absent from the global inbox shows the same two asks in its list badge and header", async () => {
  const archived = makeRunView({ archived_at: "2026-01-01T00:00:00Z", units: [makeRunUnitSummary({ asks: ["approve", "request_changes"] })] });
  const attention = makeInboxPage({ items: [
    makeInboxDecision({ run_id: "run-1", unit_id: "unit-1", key: "approve" }),
    makeInboxDecision({ run_id: "run-1", unit_id: "unit-1", key: "request_changes" }),
  ] });
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("/run-inboxes?ids=")) return Response.json({ items: [{ run_id: "run-1", items: attention.items }] });
    if (url.endsWith("/runs/run-1/inbox")) return Response.json(attention);
    if (url.endsWith("/runs/run-1")) return Response.json(archived);
    if (url.endsWith("/runs?archived=true")) return Response.json({ items: [archived], next_cursor: null });
    if (url.endsWith("/runs")) return Response.json({ items: [], next_cursor: null });
    if (url.endsWith("/definitions/bundle-1")) return Response.json(makeDefinitionSummary());
    if (url.endsWith("/units")) return Response.json([unit]);
    if (url.endsWith("/history")) return Response.json(makeUnitHistory());
    if (url.endsWith("/threads")) return Response.json([]);
    if (url.endsWith("/inbox")) return Response.json(makeInboxPage());
    throw new Error(url);
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RunListView onSelectRun={() => undefined} onNewRun={() => undefined}
    onDefinitions={() => undefined} onProjects={() => undefined} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
  await waitFor(() => expect(screen.getByTestId("or-cohort-lifecycle-card").textContent).toContain("2 need attention"));
  expect(client.getQueryData(queryKeys.runAttention("run-1"))).toEqual(attention);
  show(null, client);
  await waitFor(() => expect(screen.getByTestId("or-run-identity").textContent).toContain("2 need attention"));
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/runs/run-1/inbox"))).toHaveLength(0);
  expect(screen.getByTestId("or-run-sidebar").textContent).toContain("2 need attention");
});

it("keeps run details visible and labels attention unavailable after a failed first read", async () => {
  stubWorkspace({ failed: "attention" });
  show();
  expect((await screen.findByRole("alert")).textContent).toContain("attention unavailable");
  expect(screen.getByTestId("or-run-identity").textContent).toContain("Attention unavailable");
  expect(screen.getByTestId("or-run-overview").textContent).toContain("Attention unavailable");
  expect(screen.getByTestId("or-run-sidebar").textContent).toContain("Attention unavailable");
  expect(screen.getByTestId("or-run-overview").textContent).not.toContain("0 need attention");
});

it("uses one enumerated run accent on the identity header", async () => {
  stubWorkspace();
  show();
  const header = await screen.findByTestId("or-run-identity");
  expect(Array.from(header.classList).filter((name) => name.startsWith("or-run-accent--"))).toHaveLength(1);
  expect(header.getAttribute("style")).toBeNull();
});

it("an artifact click addresses its revision in the run route", async () => {
  stubWorkspace();
  show();
  fireEvent.click(await screen.findByRole("button", { name: /build_result/ }));
  expect(window.location.hash).toBe("#oakridge/run/run-1/artifact/revision-1");
});

it("an artifact route mounts checked review in the same workspace", async () => {
  stubWorkspace();
  show({ kind: "artifact", artifact_id: "revision-1" as ArtifactId });
  await screen.findByText("Build completed");
  expect(screen.queryByTestId("or-run-overview")).toBeNull();
});

it("shows a run load failure as an alert", async () => {
  stubWorkspace({ failed: "run" });
  show();
  expect((await screen.findByRole("alert")).textContent).toContain("run unavailable");
});

it("keeps the overview visible when the selected unit read fails", async () => {
  stubWorkspace({ failed: "unit" });
  show();
  expect((await screen.findByText(/Could not load unit:.*unit unavailable/)).getAttribute("role")).toBe("alert");
  expect(screen.getByTestId("or-run-overview")).toBeTruthy();
});

it("reports a pinned definition read failure separately", async () => {
  stubWorkspace({ failed: "definition" });
  show();
  expect((await screen.findByRole("alert")).textContent).toContain("definition unavailable");
});

it("shows decisions from live unit decisions", async () => {
  stubWorkspace({ unit: makeUnitView({ decisions: [makeDecision()], unit_id: "unit-1" }) });
  show();
  await waitFor(() => expect(screen.getByTestId("or-parked-gates").textContent).toContain("Approve"));
});
