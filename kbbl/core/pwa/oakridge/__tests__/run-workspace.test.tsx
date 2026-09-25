import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { RunDetailView } from "../views/RunDetailView";
import { ArtifactWorkspaceRedirectView } from "../views/ArtifactWorkspaceRedirectView";
import { SessionWorkspaceRedirectView } from "../views/SessionWorkspaceRedirectView";
import { runWorkspaceStorageKey } from "../lib/run-workspace-storage";
import { EventSourceStub } from "./run-pane-fixtures";
import type { ArtifactId, Sid } from "../../lib/ids";
import type { ParkedGate, RunDetail, RunSessionAttempt } from "../types";

// Pane-host wiring only. kbbl's frontend convention keeps tests on lib/ logic;
// what lands here is the handful of behaviours no transform can cover — that a
// sidebar click changes the pane instead of navigating, and that restore and
// persistence are actually wired to the model.

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const RUN: RunDetail = {
  id: "run-1",
  title: "Ship the run command center",
  repository_keys: ["oakridge"],
  workflow_name: "dev_flow_v2",
  status: "parked",
  is_stuck: false,
  parked_count: 2,
  updated_at: "2026-09-01T10:00:00Z",
  stages: [
    {
      stage_instance_id: "si-plan",
      name: "plan",
      type: "delegated_session",
      status: "complete",
      artifacts: [{ id: "art-plan", type_id: "dev.plan", version: 1, created_at: "2026-09-01T08:00:00Z" }],
      delegated_kbbl_sid: "sid-plan",
      worktree: null,
    },
    {
      stage_instance_id: "si-build",
      name: "build",
      type: "delegated_session",
      status: "running",
      artifacts: [{ id: "art-build", type_id: "dev.build_result", version: 1, created_at: "2026-09-01T09:00:00Z" }],
      delegated_kbbl_sid: null,
      worktree: null,
      units: [{ unit_id: "c1", sid: "sid-c1", worktree: null, status: "running", gate: null }],
    },
  ],
};

const SESSIONS: RunSessionAttempt[] = [
  // Only the attempt list knows this one: a unit's `sid` on the run is its
  // current attempt, so a superseded attempt's transcript is reachable from
  // nowhere else. It is the case that tells whether the list was read at all.
  {
    work_order_id: "wo-0",
    session_id: "sid-c1-prior",
    stage_instance_id: "si-build",
    stage_key: "build",
    unit_id: "c1",
    reason: "initial",
    work_order_state: "abandoned",
    created_at: "2026-09-01T08:00:00Z",
    completed_at: "2026-09-01T08:20:00Z",
    executor_health_kind: null,
    cleanup_state: "complete",
  },
  {
    work_order_id: "wo-1",
    session_id: "sid-c1",
    stage_instance_id: "si-build",
    stage_key: "build",
    unit_id: "c1",
    reason: "initial",
    work_order_state: "started",
    created_at: "2026-09-01T09:00:00Z",
    completed_at: null,
    executor_health_kind: null,
    cleanup_state: "pending",
  },
];

const GATES: ParkedGate[] = [
  {
    id: "gate-1",
    gate_type: "artifact_review",
    gate_step: null,
    run_id: "run-1",
    stage_name: "build",
    unit_id: "c1",
    artifact_revision_id: "rev-1",
    worktree: null,
    resume_actions: ["approve", "reject"],
    run_state: "active",
    actionable: true,
  },
];

const makeFetch = (run: RunDetail = RUN): FetchHandler =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/gates")) return json(GATES);
    if (url.includes("/sessions")) return json(SESSIONS);
    if (url.includes("/runs/")) return json(run);
    return json([]);
  });

/** Every read answers except the one named, which 500s the way a down backend does. */
const makeFetchWithout = (failingPath: string): FetchHandler =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(failingPath)) return json({ error: "backend unavailable" }, 500);
    if (url.includes("/gates")) return json(GATES);
    if (url.includes("/sessions")) return json(SESSIONS);
    if (url.includes("/runs/")) return json(RUN);
    return json([]);
  });

const renderWorkspace = (runId = "run-1") =>
  wrap(<RunDetailView runId={runId} routePane={null} onBack={() => {}} />);

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch());
  localStorage.clear();
  // The redirect cases write the hash; reset it so no test inherits another's URL.
  history.replaceState(null, "", window.location.pathname);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the run route", () => {
  it("renders the identity header, the sidebar and the overview pane", async () => {
    renderWorkspace();

    expect((await screen.findByTestId("or-run-identity-title")).textContent).toBe(
      "Ship the run command center",
    );
    expect(screen.getByTestId("or-run-identity-status").textContent).toBe("parked");
    expect(screen.getByTestId("or-run-identity-parked").textContent).toBe("2 parked");
    expect(screen.getByTestId("or-sidebar-sessions")).toBeTruthy();
    expect(screen.getByTestId("or-sidebar-artifacts")).toBeTruthy();
    expect(screen.getByTestId("or-run-overview")).toBeTruthy();
  });

  it("applies exactly one enumerated accent class and no inline colour", async () => {
    renderWorkspace();
    const workspace = await screen.findByTestId("or-run-workspace");

    const accents = Array.from(workspace.classList).filter((name) =>
      name.startsWith("or-run-accent--"),
    );
    expect(accents).toHaveLength(1);
    expect(workspace.getAttribute("style")).toBeNull();
  });

  it("lists every session of the run with its state and attempt label", async () => {
    renderWorkspace();

    await screen.findByTestId("or-sidebar-sessions");
    expect(screen.getAllByTestId("or-sidebar-session-state").map((el) => el.textContent)).toEqual([
      "abandoned",
      "started",
    ]);
    expect(
      screen.getAllByTestId("or-sidebar-session-attempt").map((el) => el.textContent),
    ).toEqual(["attempt 1 of 2", "attempt 2 of 2"]);
    // Only the current attempt is the unit, and only the unit can owe a decision.
    expect(screen.getAllByTestId("or-sidebar-session-superseded")).toHaveLength(1);
    expect(screen.getAllByTestId("or-sidebar-session-current")).toHaveLength(1);
    expect(screen.getAllByTestId("or-sidebar-session-action-required")).toHaveLength(1);
  });
});

describe("opening a pane from the sidebar", () => {
  it("changes the pane rather than navigating away", async () => {
    renderWorkspace();
    const hashBefore = window.location.hash;
    const rows = await screen.findAllByTestId("or-sidebar-artifact");

    fireEvent.click(rows[0]);

    await waitFor(() => expect(screen.getByTestId("or-run-pane-primary")).toBeTruthy());
    expect(screen.queryByTestId("or-run-overview")).toBeNull();
    expect(window.location.hash).toBe(hashBefore);
  });
});

describe("twin view", () => {
  const openTwin = async () => {
    renderWorkspace();
    fireEvent.click(await screen.findByTestId("or-sidebar-pane-list-twin"));
    await waitFor(() => expect(screen.getByTestId("or-run-pane-secondary")).toBeTruthy());
  };

  it("renders the overview beside the stage list", async () => {
    await openTwin();

    expect(screen.getByTestId("or-run-panes").getAttribute("data-twin")).toBe("true");
    expect(screen.getByTestId("or-run-overview")).toBeTruthy();
  });

  it("swaps the panes when one is sent to the other side", async () => {
    await openTwin();

    fireEvent.click(screen.getByTestId("or-run-pane-move-primary"));

    await waitFor(() =>
      expect(screen.getByTestId("or-run-pane-secondary").getAttribute("aria-label")).toBe(
        "Overview pane",
      ),
    );
  });

  it("closes the secondary pane", async () => {
    await openTwin();

    fireEvent.click(screen.getByTestId("or-run-pane-close-secondary"));

    await waitFor(() => expect(screen.queryByTestId("or-run-pane-secondary")).toBeNull());
  });

  it("promotes the secondary when the primary closes", async () => {
    await openTwin();

    fireEvent.click(screen.getByTestId("or-run-pane-close-primary"));

    await waitFor(() => expect(screen.queryByTestId("or-run-pane-secondary")).toBeNull());
    expect(screen.getByTestId("or-run-pane-primary").getAttribute("aria-label")).toBe("Stages pane");
  });

  it("collapses to a single pane from the sidebar", async () => {
    await openTwin();

    fireEvent.click(screen.getByTestId("or-sidebar-collapse"));

    await waitFor(() => expect(screen.queryByTestId("or-run-pane-secondary")).toBeNull());
  });
});

describe("legacy deep links converge on the workspace URL", () => {
  it("resolves an artifact to its run and replaces the hash", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ id: "art-plan", run_id: "run-1", type_id: "dev.plan", revisions: [] }),
    );

    wrap(<ArtifactWorkspaceRedirectView artifactId={"art-plan" as ArtifactId} onBack={() => {}} />);

    await waitFor(() =>
      expect(window.location.hash).toBe("#oakridge/run/run-1/artifact/art-plan"),
    );
  });

  it("resolves a session to its run and replaces the hash", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({
        run_id: "run-1",
        stage_instance_id: "si-build",
        stage_key: "build",
        unit_id: "c1",
        work_order_id: "wo-1",
      }),
    );

    wrap(<SessionWorkspaceRedirectView sessionId={"sid-c1" as Sid} onBack={() => {}} />);

    await waitFor(() => expect(window.location.hash).toBe("#oakridge/run/run-1/session/sid-c1"));
  });

  it("shows a not-found state for a session that belongs to no run", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ error: "not found" }, 404));

    wrap(<SessionWorkspaceRedirectView sessionId={"sid-orphan" as Sid} onBack={() => {}} />);

    expect(await screen.findByTestId("or-session-not-in-run")).toBeTruthy();
  });

  it("shows an error rather than 'belongs to no run' when the lookup itself fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ error: "down" }, 500));

    wrap(<SessionWorkspaceRedirectView sessionId={"sid-c1" as Sid} onBack={() => {}} />);

    expect(await screen.findByTestId("or-session-redirect-error")).toBeTruthy();
    expect(screen.queryByTestId("or-session-not-in-run")).toBeNull();
  });
});

describe("a read the workspace cannot complete", () => {
  it("opens the run anyway when the sessions read fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchWithout("/sessions"));

    renderWorkspace();

    expect(await screen.findByTestId("or-run-overview")).toBeTruthy();
    expect(screen.queryByTestId("or-run-workspace-loading")).toBeNull();
  });

  it("says the gate status is unavailable instead of that no gate is open", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchWithout("/gates"));

    renderWorkspace();

    expect(await screen.findByTestId("or-overview-gates-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("or-overview-no-gates")).toBeNull();
    expect(screen.queryByTestId("or-overview-no-awaiting")).toBeNull();
  });

  it("marks the sidebar's action state unknown rather than dropping the markers silently", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchWithout("/gates"));

    renderWorkspace();

    expect(await screen.findByTestId("or-sidebar-sessions-gates-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("or-sidebar-session-action-required")).toBeNull();
  });

  it("says the session list is unavailable rather than that the run has none", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchWithout("/sessions"));

    renderWorkspace();

    expect(await screen.findByTestId("or-sidebar-sessions-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("or-sidebar-sessions-empty")).toBeNull();
  });

  it("says the overview cannot tell what is executing, rather than that nothing is", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchWithout("/sessions"));

    renderWorkspace();

    expect(await screen.findByTestId("or-overview-current-session-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("or-overview-no-current-session")).toBeNull();
  });

  it("does not let an intact gate list claim nothing is waiting on a decision", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchWithout("/sessions"));

    renderWorkspace();

    // The two sections would otherwise contradict each other on screen: the gate
    // read landed, so "Active gates" lists an open gate, while "Awaiting you"
    // derives from the attempt list and reports the run as settled.
    expect(await screen.findByTestId("or-overview-gate")).toBeTruthy();
    expect(screen.getByTestId("or-overview-awaiting-sessions-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("or-overview-no-awaiting")).toBeNull();
  });

  it("validates the arrangement once a failed sessions read recovers", async () => {
    localStorage.setItem(
      runWorkspaceStorageKey("run-1"),
      JSON.stringify({ primary: { kind: "session", session_id: "sid-gone" }, secondary: null }),
    );
    vi.stubGlobal("EventSource", EventSourceStub);
    let sessionsAnswer = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/gates")) return json(GATES);
      if (url.includes("/sessions")) {
        return sessionsAnswer ? json(SESSIONS) : json({ error: "backend unavailable" }, 500);
      }
      if (url.includes("/runs/")) return json(RUN);
      return json([]);
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RunDetailView runId="run-1" routePane={null} onBack={() => {}} />
      </QueryClientProvider>,
    );

    // Blind, restore keeps the pane — it has nothing to disprove it with.
    await waitFor(() => expect(screen.getByTestId("or-run-pane-primary")).toBeTruthy());
    expect(screen.getByTestId("or-run-pane-primary").getAttribute("aria-label")).toBe(
      "Session pane",
    );

    sessionsAnswer = true;
    await client.refetchQueries({ queryKey: ["oakridge", "run", "run-1", "sessions"] });

    // The restore effect cannot revisit this — `state` is set, so it returns at
    // the first guard — which makes the recovered read the only pass that will
    // ever get to find out the run does not contain `sid-gone`.
    await waitFor(() => expect(screen.getByTestId("or-run-overview")).toBeTruthy());
    expect(localStorage.getItem(runWorkspaceStorageKey("run-1"))).not.toContain("sid-gone");
  });

  it("keeps a stored session pane, and its storage entry, through a failed sessions read", async () => {
    const stored = JSON.stringify({
      primary: { kind: "session", session_id: "sid-c1-prior" },
      secondary: null,
    });
    localStorage.setItem(runWorkspaceStorageKey("run-1"), stored);
    // Restoring a session pane mounts the real session body, which opens a
    // stream jsdom has no EventSource for.
    vi.stubGlobal("EventSource", EventSourceStub);
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchWithout("/sessions"));

    renderWorkspace();

    // Read as an empty list, the failed read makes this pane unresolvable and
    // the prune that follows outlives the outage — the operator's arrangement
    // is gone for good once the next poll succeeds.
    await waitFor(() => expect(screen.getByTestId("or-run-pane-primary")).toBeTruthy());
    expect(screen.getByTestId("or-run-pane-primary").getAttribute("aria-label")).toBe(
      "Session pane",
    );
    expect(localStorage.getItem(runWorkspaceStorageKey("run-1"))).toContain("sid-c1-prior");
  });
});

describe("restoring an arrangement", () => {
  it("persists the arrangement so a reload brings the panes back", async () => {
    const first = renderWorkspace();
    fireEvent.click(await screen.findByTestId("or-sidebar-pane-list-twin"));
    await waitFor(() =>
      expect(localStorage.getItem(runWorkspaceStorageKey("run-1"))).toContain("list"),
    );
    first.unmount();

    renderWorkspace();

    await waitFor(() => expect(screen.getByTestId("or-run-pane-secondary")).toBeTruthy());
  });

  it("keeps each run's arrangement to itself", async () => {
    localStorage.setItem(
      runWorkspaceStorageKey("run-1"),
      JSON.stringify({ primary: { kind: "overview" }, secondary: { kind: "list" } }),
    );

    renderWorkspace("run-2");

    await waitFor(() => expect(screen.getByTestId("or-run-pane-primary")).toBeTruthy());
    expect(screen.queryByTestId("or-run-pane-secondary")).toBeNull();
  });

  it("falls back to the overview and prunes when the stored pane is gone", async () => {
    localStorage.setItem(
      runWorkspaceStorageKey("run-1"),
      JSON.stringify({ primary: { kind: "artifact", artifact_id: "art-deleted" }, secondary: null }),
    );

    renderWorkspace();

    expect(await screen.findByTestId("or-run-overview")).toBeTruthy();
    expect(localStorage.getItem(runWorkspaceStorageKey("run-1"))).not.toContain("art-deleted");
  });
});
