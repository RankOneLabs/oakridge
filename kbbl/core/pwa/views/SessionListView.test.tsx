import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";

import type { RuntimeDescriptor, SessionSnapshot } from "../types";
import type { PwaSessionWorkflowIdentity } from "../../acp/pwa-wire";
import type { OperatorRunView } from "../oakridge/operator-contracts";
import { SessionListView } from "./SessionListView";

const runtimes: RuntimeDescriptor[] = [
  { id: "claude-code", label: "Claude Code", models: [], efforts: [], supportsCompaction: false },
];

function workflow(overrides: Partial<PwaSessionWorkflowIdentity> = {}): PwaSessionWorkflowIdentity {
  return {
    runId: "run-1",
    stageInstanceId: "stage-build",
    unitId: "cohort-one",
    cohortId: "cohort-one",
    operatorRole: "build",
    cohortTitle: "Cohort One",
    repositoryKey: "oakridge",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sid: "sid-1",
    name: "hand-started-session",
    agentProfile: "claude-code",
    status: "idle",
    source: "acp",
    lastActivityTs: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    artifactId: null,
    projectWorkdir: "/repo",
    worktreePath: "/repo/worktree",
    worktreeBranch: null,
    worktreeBaseRef: null,
    requestedModel: null,
    requestedEffort: null,
    endReason: null,
    fencedBy: null,
    pendingPermissionCount: 0,
    workflow: null,
    ...overrides,
  };
}

const runSummary: OperatorRunView = {
  run_id: "run-1",
  definition_bundle_id: "bundle-1",
  definition_digest: "sha-1",
  version: 1,
  created_at: "2026-10-09T00:00:00.000Z",
  archived_at: null,
  cursor: [{ scope_id: "stage-plan", version: 1 }],
  scopes: [{ scope_id: "stage-plan", scope_key: "planning", label: "Plan the work",
    version: 1, is_terminal: false, available_commands: [] }],
};

const runDetail: OperatorRunView = runSummary;

function renderList(
  sessions: Map<string, SessionSnapshot>,
  seedRunData = true,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  if (seedRunData) {
    client.setQueryData(["operator", "runs"], [runSummary]);
    client.setQueryData(["operator", "run", "run-1"], runDetail);
  }
  return render(
    <QueryClientProvider client={client}>
      <SessionListView
        sessions={sessions}
        inboxStatus="connected"
        defaultWorkdir="/repo"
        defaultRuntimeId="claude-code"
        runtimes={runtimes}
        onSelect={() => {}}
        onHydrateSession={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("SessionListView grouping", () => {
  test("prefill autostart creates a session from a no-hash URL", async () => {
    history.replaceState(null, "", "/?workdir=%2Ftmp%2Fx&autostart=true");
    const created = makeSnapshot({ sid: "autostart-session", projectWorkdir: "/tmp/x" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(created), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const onSelect = vi.fn();
    const onHydrateSession = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    try {
      render(
        <QueryClientProvider client={client}>
          <SessionListView
            sessions={new Map()}
            inboxStatus="connected"
            defaultWorkdir="/repo"
            defaultRuntimeId="claude-code"
            runtimes={runtimes}
            onSelect={onSelect}
            onHydrateSession={onHydrateSession}
          />
        </QueryClientProvider>,
      );

      expect(screen.getByLabelText("Workdir for new session")).toHaveProperty("value", "/tmp/x");
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
      const request = fetchSpy.mock.calls[0];
      expect(request[0]).toBe("/sessions");
      expect(JSON.parse(String(request[1]?.body))).toMatchObject({ workdir: "/tmp/x" });
      await waitFor(() => expect(onHydrateSession).toHaveBeenCalledWith(created));
      expect(onSelect).toHaveBeenCalledWith("autostart-session");
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("#sessions");
    } finally {
      history.replaceState(null, "", "/");
      vi.restoreAllMocks();
    }
  });

  test("loads projected run and scope labels and renders a trailing unattached section", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/oakridge/api/api/runs") {
        return new Response(JSON.stringify({ items: [runSummary], next_cursor: null }), { status: 200 });
      }
      if (url === "/oakridge/api/api/runs/run-1") {
        return new Response(JSON.stringify(runDetail), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const build = makeSnapshot({ sid: "build-1", name: "build-stage-1-cohort-one", workflow: workflow() });
    const assess = makeSnapshot({
      sid: "assess-1",
      name: "assessor-stage-2-cohort-one",
      workflow: workflow({ operatorRole: "assessment", stageInstanceId: "stage-assess", cohortTitle: null }),
    });
    const scalar = makeSnapshot({
      sid: "plan-1",
      name: "planner-stage-plan-0",
      workflow: workflow({
        stageInstanceId: "stage-plan",
        unitId: "0",
        cohortId: null,
        operatorRole: "planning",
        cohortTitle: null,
        repositoryKey: null,
      }),
    });
    const handStarted = makeSnapshot({ sid: "hand-1", name: "hand-started-session", workflow: null });

    try {
      const { container } = renderList(new Map([
        [build.sid, build],
        [assess.sid, assess],
        [scalar.sid, scalar],
        [handStarted.sid, handStarted],
      ]), false);

      const run = screen.getByTestId("session-run-run-1");
      expect(await within(run).findByText("run-1")).toBeTruthy();
      expect(screen.getByText("Cohort One")).toBeTruthy();
      expect(screen.getByText("cohort-one")).toBeTruthy();
      expect(await within(run).findByText("Plan the work")).toBeTruthy();
      expect(within(run).queryByText("stage-plan")).toBeNull();
      expect(within(run).getByText("planning-0")).toBeTruthy();
      expect(screen.getByText("oakridge")).toBeTruthy();
      expect(screen.getByText("build")).toBeTruthy();
      expect(screen.getByText("assessment")).toBeTruthy();
      expect(screen.getByText("Unattached sessions")).toBeTruthy();
      expect(screen.getByTestId("unattached-sessions")).toBeTruthy();
      expect(container.querySelectorAll(".session-cohort-group")).toHaveLength(3);
      expect(screen.queryByText("No sessions yet.")).toBeNull();
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/oakridge/api/api/runs", expect.objectContaining({ method: "GET" })));
      expect(fetchSpy).toHaveBeenCalledWith("/oakridge/api/api/runs/run-1", expect.objectContaining({ method: "GET" }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("does not load run detail when every subgroup is a cohort", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/oakridge/api/api/runs") {
        return new Response(JSON.stringify({ items: [runSummary], next_cursor: null }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const build = makeSnapshot({
      sid: "build-1",
      name: "build-stage-1-cohort-one",
      workflow: workflow(),
    });

    try {
      renderList(new Map([[build.sid, build]]), false);

      expect(await screen.findByText("run-1")).toBeTruthy();
      expect(screen.getByText("Cohort One")).toBeTruthy();
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/oakridge/api/api/runs", expect.objectContaining({ method: "GET" })));
      expect(fetchSpy.mock.calls.map(([url]) => url)).not.toContain("/oakridge/api/api/runs/run-1");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("renders the empty state only when there are no sessions at all", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = (sessions: Map<string, SessionSnapshot>) => (
      <QueryClientProvider client={client}>
        <SessionListView
          sessions={sessions}
          inboxStatus="connected"
          defaultWorkdir="/repo"
          defaultRuntimeId="claude-code"
          runtimes={runtimes}
          onSelect={() => {}}
          onHydrateSession={() => {}}
        />
      </QueryClientProvider>
    );

    const { container, rerender } = render(view(new Map()));
    expect(screen.getByText("No sessions yet.")).toBeTruthy();
    expect(container.querySelectorAll(".session-cohort-group")).toHaveLength(0);

    const handStarted = makeSnapshot({ sid: "hand-1", workflow: null });
    rerender(view(new Map([[handStarted.sid, handStarted]])));

    expect(screen.queryByText("No sessions yet.")).toBeNull();
    expect(screen.getByText("Unattached sessions")).toBeTruthy();
  });

  test("returns to newest-first order when the just-now bucket expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    try {
      const established = makeSnapshot({
        sid: "established",
        name: "established",
        lastActivityTs: "2026-01-01T00:00:04.000Z",
      });
      const newest = makeSnapshot({
        sid: "newest",
        name: "newest",
        lastActivityTs: "2026-01-01T00:00:05.000Z",
      });
      const { container } = renderList(new Map([
        [established.sid, established],
        [newest.sid, newest],
      ]));
      const visibleNames = () => Array.from(container.querySelectorAll(".session-row-name"))
        .map((node) => node.textContent);

      expect(visibleNames()).toEqual(["established", "newest"]);
      act(() => vi.advanceTimersByTime(5_000));
      expect(visibleNames()).toEqual(["newest", "established"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
