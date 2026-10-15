import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";

import {
  makeBuildResultFixture, makeDecision, makeDefinitionSummary, makeRunView, makeRunUnitSummary, makeUnitWithArtifact, makeSessionSnapshot,
} from "../__fixtures__/read-models";
import { RunWorkspace } from "../components/organisms/RunWorkspace";
import { RunSessionPane } from "../components/organisms/RunSessionPane";
import { useStore } from "../../state/store";
import type { ArtifactId, Sid } from "../../lib/ids";
import { EventSourceStub, renderWithQuery } from "./run-pane-fixtures";

const sessionId = "sid-c1" as Sid;
const revisionId = "revision-1" as ArtifactId;
const renderSession = () => renderWithQuery(<RunSessionPane sessionId={sessionId} onOpenSession={() => undefined} />);

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  vi.stubGlobal("EventSource", EventSourceStub);
  EventSourceStub.instances = [];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
  useStore.setState(useStore.getInitialState());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useStore.setState(useStore.getInitialState()); });

it("an artifact route mounts the checked review renderer in the workspace", async () => {
  const result = makeBuildResultFixture({ summary: "Two panes, one renderer" });
  const unit = makeUnitWithArtifact({ body: result.body, artifact_key: "build_result", revision_id: "revision-1",
    schema: "build_body", unit: { decisions: [makeDecision({ label: "Approve the build" })] } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/runs/run-1")) return Response.json(makeRunView({ units: [makeRunUnitSummary()] }));
    if (url.endsWith("/definitions/bundle-1")) return Response.json(makeDefinitionSummary());
    if (url.endsWith("/units")) return Response.json([unit]);
    if (url.endsWith("/threads")) return Response.json([]);
    throw new Error(url);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <RunWorkspace runId="run-1" routePane={{ kind: "artifact", artifact_id: revisionId }} unitId="unit-1" onBack={() => undefined} />
  </QueryClientProvider>);
  await screen.findByText("Two panes, one renderer");
  expect(screen.getByRole("button", { name: "← Overview" })).toBeTruthy();
  expect(screen.getByTestId("or-artifact-threads")).toBeTruthy();
  expect(screen.getByTestId("or-gate-actions").textContent).toContain("Approve the build");
});

it("a session route embeds the existing transcript surface", async () => {
  useStore.setState({ sessions: new Map([[sessionId, makeSessionSnapshot(sessionId)]]), inboxStatus: "connected" });
  renderSession();
  const host = screen.getByTestId("or-run-pane-session");
  expect(host.getAttribute("data-session-id")).toBe("sid-c1");
  expect(host.querySelector(".events")).toBeTruthy();
  expect(EventSourceStub.instances.some((source) => source.url.includes("sid-c1"))).toBe(true);
  expect(host.querySelector(".app")?.classList.contains("session-surface--embedded")).toBe(true);
  expect(host.querySelector(".bottom-stack")).toBeTruthy();
  expect(document.body.querySelectorAll(".bottom-stack")).toHaveLength(1);
});

it("the embedded transcript keeps session identity and pane chrome", () => {
  useStore.setState({ sessions: new Map([[sessionId, makeSessionSnapshot(sessionId)]]), inboxStatus: "connected" });
  renderSession();
  const topBar = screen.getByTestId("or-run-pane-session").querySelector(".top-bar");
  expect(topBar?.getAttribute("data-chrome")).toBe("pane");
  expect(topBar?.querySelector(".status")).toBeTruthy();
  expect(topBar?.querySelector(".session-label-name")?.textContent).toBe("session sid-c1");
  expect(topBar?.querySelector(".back-button")).toBeNull();
  expect(topBar?.querySelector('[aria-label^="Switch to"]')).toBeNull();
});

it("resuming an ended session replaces the transcript in the same pane", async () => {
  useStore.setState({ sessions: new Map([[sessionId, makeSessionSnapshot(sessionId, { status: "ended" })]]), inboxStatus: "connected" });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
    url === "/sessions" && init?.method === "POST"
      ? Response.json(makeSessionSnapshot("sid-resumed")) : Response.json([])));
  function Pane() {
    const [selected, setSelected] = useState<Sid>(sessionId);
    return <RunSessionPane sessionId={selected} onOpenSession={setSelected} />;
  }
  renderWithQuery(<Pane />);
  fireEvent.click(await screen.findByText("Resume in new session"));
  await waitFor(() => expect(screen.getByTestId("or-run-pane-session").getAttribute("data-session-id")).toBe("sid-resumed"));
});
