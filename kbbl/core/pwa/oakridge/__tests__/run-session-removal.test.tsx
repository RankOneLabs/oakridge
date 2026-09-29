import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RunDetailView } from "../views/RunDetailView";
import { useStore } from "../../state/store";
import type { SessionSnapshot } from "../../types";
import type { RunDetail, RunSessionAttempt } from "../types";
import { writeStoredRunWorkspace } from "../lib/run-workspace-storage";
import type { Sid } from "../../lib/ids";

const run: RunDetail = {
  id: "run-removal", title: "Removal regression", repository_keys: [],
  workflow_name: "dev_flow_v2", status: "blocked", blocked_reason: "gate", next_actor: "operator",
  parked_count: 0, updated_at: "2026-09-01T00:00:00Z", stages: [],
};
const attempts: RunSessionAttempt[] = ["deleted", "existing"].map((session_id, index) => ({
  work_order_id: `work-${index}`, session_id, stage_instance_id: "stage",
  stage_key: "build", unit_id: "unit", reason: "initial",
  work_order_state: "completed", created_at: "2026-09-01T00:00:00Z",
  completed_at: null, executor_health_kind: null, cleanup_state: "complete",
}));
const existing: SessionSnapshot = {
  sid: "existing", name: "existing", agentProfile: "codex", status: "idle",
  source: "acp", lastActivityTs: "2026-09-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z",
  artifactId: null, projectWorkdir: "/repo", worktreePath: "/repo",
  worktreeBranch: null, worktreeBaseRef: null, requestedModel: null,
  requestedEffort: null, endReason: null, fencedBy: null, pendingPermissionCount: 0, workflow: null,
};

beforeEach(() => {
  useStore.setState(useStore.getInitialState());
  localStorage.clear();
  useStore.getState().seedSessions([]);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.endsWith("/diagnosis") ? {
      run,
      sessions: attempts.map((attempt, index) => ({ session_id: attempt.session_id, stage_key: attempt.stage_key,
        cohort_id: attempt.unit_id, attempt_number: index + 1, attempt_count: attempts.length, status: "complete" })),
      current_session: null, sessions_awaiting_action: [], active_gates: [], recent_artifacts: [],
      stage_progress: { total: 0, pending: 0, active: 0, blocked: 0, complete: 0, failed: 0, cancelled: 0 },
    } : [];
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useStore.setState(useStore.getInitialState());
  localStorage.clear();
});

const renderRun = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <RunDetailView runId={run.id} routePane={null} onBack={() => {}} />
  </QueryClientProvider>,
);
const visibleSessions = () => screen.queryAllByTestId("or-sidebar-session")
  .map((row) => row.getAttribute("data-session-id"));

it("on a fresh page hides previously deleted sessions and drops their saved panes", async () => {
  writeStoredRunWorkspace(run.id, {
    primary: { kind: "session", session_id: "deleted" as Sid }, secondary: null,
  });
  useStore.getState().applySnapshot([existing]);
  renderRun();
  await screen.findByTestId("or-run-workspace");
  expect(visibleSessions()).toEqual(["existing"]);
  expect(screen.queryByTestId("or-run-pane-session")).toBeNull();
  expect(screen.getByTestId("or-sidebar-session-attempt").textContent).toBe("attempt 2 of 2");
});

it("does not infer deletion before inventory arrives, then reconciles the first snapshot", async () => {
  renderRun();
  await screen.findByTestId("or-run-workspace");
  expect(visibleSessions()).toEqual(["deleted", "existing"]);
  act(() => { useStore.getState().applySnapshot([existing]); });
  await waitFor(() => expect(visibleSessions()).toEqual(["existing"]));
});

it("an empty server inventory remains authoritative over a late seed response", async () => {
  useStore.getState().applySnapshot([]);
  useStore.getState().seedSessions([existing]);
  renderRun();
  await screen.findByTestId("or-run-workspace");
  expect(visibleSessions()).toEqual([]);
});

it("removes sessions deleted by another client after the page has loaded", async () => {
  useStore.getState().applySnapshot([existing]);
  renderRun();
  await screen.findByTestId("or-run-workspace");
  act(() => { useStore.getState().applySnapshot([]); });
  await waitFor(() => expect(visibleSessions()).toEqual([]));
});
