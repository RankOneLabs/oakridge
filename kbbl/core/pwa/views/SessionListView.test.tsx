import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";

import type { RuntimeDescriptor, SessionSnapshot } from "../types";
import type { PwaSessionWorkflowIdentity } from "../../acp/pwa-wire";
import { SessionListView } from "./SessionListView";

const runtimes: RuntimeDescriptor[] = [
  { id: "claude-code", label: "Claude Code", models: [], efforts: [], supportsCompaction: false },
];

function workflow(overrides: Partial<PwaSessionWorkflowIdentity> = {}): PwaSessionWorkflowIdentity {
  return {
    runId: "run-1",
    stageInstanceId: "stage-build",
    unitId: "cohort-one",
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

function renderList(sessions: Map<string, SessionSnapshot>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionListView
        sessions={sessions}
        inboxStatus="connected"
        theme="dark"
        defaultWorkdir="/repo"
        defaultRuntimeId="claude-code"
        runtimes={runtimes}
        onToggleTheme={() => {}}
        onSelect={() => {}}
        onHydrateSession={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("SessionListView grouping", () => {
  test("renders one section per cohort group plus a trailing Other sessions section", () => {
    const build = makeSnapshot({ sid: "build-1", name: "build-stage-1-cohort-one", workflow: workflow() });
    const assess = makeSnapshot({
      sid: "assess-1",
      name: "assessor-stage-2-cohort-one",
      workflow: workflow({ operatorRole: "assessment", stageInstanceId: "stage-assess", cohortTitle: null }),
    });
    const handStarted = makeSnapshot({ sid: "hand-1", name: "hand-started-session", workflow: null });

    const { container } = renderList(new Map([
      [build.sid, build],
      [assess.sid, assess],
      [handStarted.sid, handStarted],
    ]));

    expect(screen.getByText("Cohort One")).toBeTruthy();
    expect(screen.getByText("cohort-one")).toBeTruthy();
    expect(screen.getByText("oakridge")).toBeTruthy();
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("assessment")).toBeTruthy();
    expect(screen.getByText("Other sessions")).toBeTruthy();
    expect(container.querySelectorAll(".session-cohort-group")).toHaveLength(2);
    expect(screen.queryByText("No sessions yet.")).toBeNull();
  });

  test("renders the empty state only when there are no sessions at all", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = (sessions: Map<string, SessionSnapshot>) => (
      <QueryClientProvider client={client}>
        <SessionListView
          sessions={sessions}
          inboxStatus="connected"
          theme="dark"
          defaultWorkdir="/repo"
          defaultRuntimeId="claude-code"
          runtimes={runtimes}
          onToggleTheme={() => {}}
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
    expect(screen.getByText("Other sessions")).toBeTruthy();
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
