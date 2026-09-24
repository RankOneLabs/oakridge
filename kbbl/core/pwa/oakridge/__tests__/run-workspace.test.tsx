import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { RunDetailView } from "../views/RunDetailView";
import { ArtifactWorkspaceRedirectView } from "../views/ArtifactWorkspaceRedirectView";
import { SessionWorkspaceRedirectView } from "../views/SessionWorkspaceRedirectView";
import { runWorkspaceStorageKey } from "../lib/run-workspace-storage";
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

    expect((await screen.findByTestId("or-sidebar-session-state")).textContent).toBe("started");
    expect(screen.getByTestId("or-sidebar-session-attempt").textContent).toBe("attempt 1");
    expect(screen.getByTestId("or-sidebar-session-current")).toBeTruthy();
    expect(screen.getByTestId("or-sidebar-session-action-required")).toBeTruthy();
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
