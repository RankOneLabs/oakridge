import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";

import type { RuntimeDescriptor, SessionSnapshot } from "../types";
import type { PwaSessionWorkflowIdentity } from "../../acp/pwa-wire";
import type { RunDetail, RunSummary } from "../oakridge/types";
import type { Sid } from "../lib/ids";
import { useStore } from "../state/store";
import { SessionListView } from "./SessionListView";

const runtimes: RuntimeDescriptor[] = [
  { id: "claude-code", label: "Claude Code", models: [], efforts: [], supportsCompaction: true },
];

function workflow(overrides: Partial<PwaSessionWorkflowIdentity> = {}): PwaSessionWorkflowIdentity {
  return { runId: "run-1", unitId: "run-1/cohort/one", worker: "builder", ...overrides };
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
    archivedAt: null,
    pendingPermissionCount: 0,
    workflow: null,
    ...overrides,
  };
}

const runSummary: RunSummary = {
  id: "run-1", title: "Run one", repository_keys: ["oakridge"], workflow_name: "development",
  status: "running", current_stage: "Plan", stage_total: 1, stage_complete: 0,
  parked_count: 0, updated_at: "2026-10-09T00:00:00.000Z", is_stuck: false, is_failed: false,
};

const runDetail: RunDetail = {
  id: "run-1", title: "Run one", repository_keys: ["oakridge"], workflow_name: "development",
  status: "running", stages: [{ stage_instance_id: "stage-plan", name: "Plan the work", type: "scalar",
    status: "running", artifacts: [], delegated_kbbl_sid: null, worktree: null }],
  parked_count: 0, updated_at: "2026-10-09T00:00:00.000Z", is_stuck: false,
};

function renderList(
  sessions: Map<string, SessionSnapshot>,
  seedRunData = true,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  if (seedRunData) {
    client.setQueryData(["oakridge", "runs", "all"], [runSummary]);
    client.setQueryData(["oakridge", "run", "run-1"], runDetail);
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

function StoredSessionList() {
  const sessions = useStore((state) => state.sessions);
  return <SessionListView
    sessions={sessions}
    inboxStatus="connected"
    defaultWorkdir="/repo"
    defaultRuntimeId="claude-code"
    runtimes={runtimes}
    onSelect={() => {}}
    onHydrateSession={() => {}}
  />;
}

function renderStoredList(snapshots: SessionSnapshot[]) {
  useStore.setState({ sessions: new Map(snapshots.map((snapshot) => [snapshot.sid as Sid, snapshot])) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><StoredSessionList /></QueryClientProvider>);
}

describe("SessionListView grouping", () => {
  test("archived sessions leave the list but remain in the session inventory", () => {
    const archived = makeSnapshot({ sid: "archived", name: "archived session", status: "ended", archivedAt: "2026-10-21T00:00:00Z" });
    const visible = makeSnapshot({ sid: "visible", name: "visible session" });
    const sessions = new Map([[archived.sid, archived], [visible.sid, visible]]);
    renderList(sessions);
    expect(screen.queryByText("archived session")).toBeNull();
    expect(screen.getByText("visible session")).toBeTruthy();
    expect(sessions.has("archived")).toBe(true);
  });

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

  test("groups a run's sessions by unit under the unit's label and renders a trailing unattached section", async () => {
    const build = makeSnapshot({ sid: "build-1", name: "builder · cohort/one", workflow: workflow() });
    const assess = makeSnapshot({ sid: "assess-1", name: "assessor · cohort/one", workflow: workflow({ worker: "assessor" }) });
    const plan = makeSnapshot({ sid: "plan-1", name: "planner · planning", workflow: workflow({ unitId: "stage-plan", worker: "planner" }) });
    const handStarted = makeSnapshot({ sid: "hand-1", name: "hand-started-session", workflow: null });

    try {
      const { container } = renderList(new Map([
        [build.sid, build],
        [assess.sid, assess],
        [plan.sid, plan],
        [handStarted.sid, handStarted],
      ]));

      const run = screen.getByTestId("session-run-run-1");
      expect(await within(run).findByText("Run one")).toBeTruthy();
      expect(await within(run).findByText("Plan the work")).toBeTruthy();
      expect(within(run).getByText("run-1/cohort/one")).toBeTruthy();
      expect(within(run).getByText("builder")).toBeTruthy();
      expect(within(run).getByText("assessor")).toBeTruthy();
      expect(within(run).getByText("planner · planning")).toBeTruthy();
      expect(screen.getByText("Unattached sessions")).toBeTruthy();
      expect(screen.getByTestId("unattached-sessions")).toBeTruthy();
      expect(container.querySelectorAll(".session-cohort-group")).toHaveLength(3);
      expect(screen.queryByText("No sessions yet.")).toBeNull();
    } finally {
      vi.restoreAllMocks();
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

describe("SessionListView bulk hide", () => {
  test("shows no bulk control without an eligible session", () => {
    renderStoredList([makeSnapshot({ sid: "active" }), makeSnapshot({ sid: "archived", status: "ended", archivedAt: "2026-10-21T00:00:00Z" })]);
    expect(screen.queryByRole("button", { name: /hide \d+ ended sessions?/i })).toBeNull();
  });

  test("states the exact count, requires confirmation, and only archives eligible sessions", async () => {
    const snapshots = [
      ...Array.from({ length: 7 }, (_, index) => makeSnapshot({ sid: `ended/${index}`, name: `ended ${index}`, status: "ended" })),
      makeSnapshot({ sid: "provisioning", status: "provisioning" }),
      makeSnapshot({ sid: "idle", status: "idle" }),
      makeSnapshot({ sid: "prompting", status: "prompting" }),
      makeSnapshot({ sid: "archived", status: "failed", archivedAt: "2026-10-21T00:00:00Z" }),
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    try {
      renderStoredList(snapshots);
      fireEvent.click(screen.getByRole("button", { name: "Hide 7 ended sessions" }));
      expect(fetchSpy).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Confirm hide 7 ended sessions" }));
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(7));
      expect(fetchSpy.mock.calls.map(([url, options]) => [url, options?.method])).toEqual(
        Array.from({ length: 7 }, (_, index) => [`/sessions/ended%2F${index}?archive=true`, "DELETE"]),
      );
      expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes("purge"))).toBe(true);
      await waitFor(() => expect(screen.getByTestId("bulk-hide-outcome").textContent).toContain("Archived 7 of 7"));
      expect(screen.queryByText("ended 0")).toBeNull();
      expect(useStore.getState().sessions.has("ended/0" as Sid)).toBe(true);
      expect(useStore.getState().sessions.get("ended/0" as Sid)?.archivedAt).not.toBeNull();
      expect(screen.getAllByText("hand-started-session")).toHaveLength(3);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("a lone ended session uses the singular label and disarms after four seconds", () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      renderStoredList([makeSnapshot({ sid: "one", status: "ended" })]);
      fireEvent.click(screen.getByRole("button", { name: "Hide 1 ended session" }));
      expect(screen.getByRole("button", { name: "Confirm hide 1 ended session" })).toBeTruthy();
      act(() => vi.advanceTimersByTime(4000));
      expect(screen.getByRole("button", { name: "Hide 1 ended session" })).toBeTruthy();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  test("reports successful sids and both refusal kinds while refused rows remain", async () => {
    const held = {
      error: "cannot archive right now",
      code: "session_held_by_attempt",
      hold: { session_id: "e1a84fd7-0750-404b-a82c-9daefdfbdde1", run_id: "run-5", unit_id: "unit-7", worker: "builder", action_id: "f5aeeb429c1641b3" },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("held")) return new Response(JSON.stringify(held), { status: 409 });
      if (String(url).includes("rejected")) return new Response(JSON.stringify({ error: "server rejected archive" }), { status: 500 });
      return new Response(null, { status: 204 });
    });
    try {
      renderStoredList([
        makeSnapshot({ sid: "success", name: "success row", status: "ended" }),
        makeSnapshot({ sid: "held", name: "held row", status: "fenced" }),
        makeSnapshot({ sid: "rejected", name: "rejected row", status: "failed" }),
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Hide 3 ended sessions" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm hide 3 ended sessions" }));
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
      const outcome = await screen.findByTestId("bulk-hide-outcome");
      expect(outcome.textContent).toContain("Archived 1 of 3: success");
      const failures = screen.getAllByRole("alert").map((message) => message.textContent);
      expect(failures).toContain("held: cannot archive right now (run run-5, unit unit-7)");
      expect(failures).toContain("rejected: server rejected archive");
      expect(screen.queryByText("success row")).toBeNull();
      expect(screen.getByText("held row")).toBeTruthy();
      expect(screen.getByText("rejected row")).toBeTruthy();
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("does not add a session that becomes ended after the first request starts", async () => {
    let resolveFirst: ((response: Response) => void) | null = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }));
    try {
      renderStoredList([makeSnapshot({ sid: "first", status: "ended" }), makeSnapshot({ sid: "later", status: "prompting" })]);
      fireEvent.click(screen.getByRole("button", { name: "Hide 1 ended session" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm hide 1 ended session" }));
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
      act(() => useStore.setState((state) => {
        const sessions = new Map(state.sessions);
        const later = sessions.get("later" as Sid);
        if (later) sessions.set("later" as Sid, { ...later, status: "ended" });
        return { sessions };
      }));
      await act(async () => { resolveFirst?.(new Response(null, { status: 204 })); });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(useStore.getState().sessions.get("later" as Sid)?.archivedAt).toBeNull();
      expect(screen.getByRole("button", { name: "Hide 1 ended session" })).toBeTruthy();
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("keeps no more than three archive requests in flight", async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const pending: Array<() => void> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => {
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      pending.push(() => { inFlight--; resolve(new Response(null, { status: 204 })); });
    }));
    try {
      renderStoredList(Array.from({ length: 7 }, (_, index) => makeSnapshot({ sid: `sid-${index}`, status: "ended" })));
      fireEvent.click(screen.getByRole("button", { name: "Hide 7 ended sessions" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm hide 7 ended sessions" }));
      await waitFor(() => expect(pending).toHaveLength(3));
      for (let index = 0; index < 7; index++) {
        await act(async () => { pending[index](); });
        if (index < 4) await waitFor(() => expect(pending).toHaveLength(index + 4));
      }
      expect(maximumInFlight).toBe(3);
      expect(fetchSpy).toHaveBeenCalledTimes(7);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
