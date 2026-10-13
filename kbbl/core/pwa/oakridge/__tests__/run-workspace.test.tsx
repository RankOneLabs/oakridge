import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  makeBuildResultFixture, makeDecision, makeDefinitionSummary, makeAttemptView, makeRunView,
  makeRunUnitSummary, makeUnitHistory, makeUnitView, makeUnitWithArtifact,
} from "../__fixtures__/read-models";
import { RunWorkspace } from "../components/organisms/RunWorkspace";
import type { OperatorRunView, OperatorUnitView } from "../operator-contracts";
import type { ArtifactId } from "../../lib/ids";

const result = makeBuildResultFixture({ summary: "Build completed" });
const unit = makeUnitWithArtifact({ body: result.body, artifact_key: "build_result",
  unit: { attempts: [makeAttemptView({ status: "succeeded" })] } });
const run = makeRunView({ units: [makeRunUnitSummary({ asks: ["approve"] })] });

function stubWorkspace(options: { readonly run?: OperatorRunView; readonly unit?: OperatorUnitView;
  readonly failed?: "run" | "scope" | "definition" } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/runs/run-1")) return options.failed === "run"
      ? Response.json({ detail: "run unavailable" }, { status: 503 }) : Response.json(options.run ?? run);
    if (url.endsWith("/definition")) return options.failed === "definition"
      ? Response.json({ detail: "definition unavailable" }, { status: 503 }) : Response.json(makeDefinitionSummary());
    if (url.endsWith("/units/unit-1")) return options.failed === "scope"
      ? Response.json({ detail: "unit unavailable" }, { status: 503 }) : Response.json(options.unit ?? unit);
    if (url.endsWith("/history")) return Response.json(makeUnitHistory());
    if (url.endsWith("/threads")) return Response.json([]);
    throw new Error(url);
  }));
}

function show(routePane: Parameters<typeof RunWorkspace>[0]["routePane"] = null) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
  expect(screen.getByTestId("or-sidebar-sessions").textContent).toContain("author #1");
  expect(screen.getByTestId("or-sidebar-artifacts").textContent).toContain("build_result");
  expect(screen.getByTestId("or-run-overview")).toBeTruthy();
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
  expect((await screen.findByTestId("or-artifact-review")).textContent).toContain("Build completed");
  expect(screen.queryByTestId("or-run-overview")).toBeNull();
});

it("shows a run load failure as an alert", async () => {
  stubWorkspace({ failed: "run" });
  show();
  expect((await screen.findByRole("alert")).textContent).toContain("run unavailable");
});

it("keeps the overview visible when the selected unit read fails", async () => {
  stubWorkspace({ failed: "scope" });
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
  expect((await screen.findByTestId("or-parked-gates")).textContent).toContain("Approve");
});
