import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RunDetailView } from "../views/RunDetailView";
import type { RunDiagnosis } from "../types";

const diagnosis: RunDiagnosis = {
  run: {
    id: "run-1",
    title: "Ship the run command center",
    repository_keys: ["oakridge"],
    workflow_name: "dev_flow_v15",
    status: "blocked",
    blocked_reason: "gate",
    next_actor: "operator",
    parked_count: 1,
    updated_at: "2026-09-01T10:00:00Z",
    stages: [{
      stage_instance_id: "stage-build",
      name: "build",
      type: "delegated_session",
      status: "blocked",
      blocked_reason: "gate",
      next_actor: "operator",
      artifacts: [],
      delegated_kbbl_sid: "sid-build",
      worktree: null,
      units: [{
        cohort_id: "cohort-1",
        unit_id: "cohort-1",
        sid: "sid-build",
        worktree: null,
        status: "blocked",
        blocked_reason: "gate",
        next_actor: "operator",
        gate: "artifact_review",
      }],
    }],
  },
  sessions: [{
    session_id: "sid-build",
    stage_key: "build",
    cohort_id: "cohort-1",
    attempt_number: 1,
    attempt_count: 1,
    status: "blocked",
  }],
  current_session: null,
  sessions_awaiting_action: [{
    session_id: "sid-build",
    stage_key: "build",
    cohort_id: "cohort-1",
    attempt_number: 1,
    attempt_count: 1,
    status: "blocked",
  }],
  active_gates: [{
    id: "gate-1",
    gate_type: "artifact_review",
    gate_step: "artifact_review",
    run_id: "run-1",
    stage_name: "build",
    unit_id: "cohort-1",
    cohort_id: "cohort-1",
    artifact_revision_id: null,
    worktree: null,
    resume_actions: ["approve", "request_revision"],
    run_state: "blocked",
    actionable: true,
  }],
  recent_artifacts: [],
  stage_progress: { total: 1, pending: 0, active: 0, blocked: 1, complete: 0, failed: 0, cancelled: 0 },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunDetailView runId="run-1" routePane={null} onBack={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
describe("run diagnosis workspace", () => {
  it("loads every operator pane from the single diagnosis read", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/diagnosis")) return json(diagnosis);
      if (url.endsWith("/events")) return json([]);
      return json({ error: "unexpected read" }, 500);
    });

    renderWorkspace();

    expect(await screen.findByTestId("or-run-workspace")).toBeTruthy();
    expect(screen.getByTestId("or-run-identity-status").textContent).toBe("blocked");
    const requested = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requested.filter((url) => url.endsWith("/diagnosis"))).toHaveLength(1);
    expect(requested.some((url) => url.endsWith("/sessions"))).toBe(false);
    expect(requested.some((url) => url.endsWith("/gates"))).toBe(false);
  });

  it("surfaces a diagnosis outage as the workspace failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "diagnosis unavailable" }, 503));
    renderWorkspace();
    expect(await screen.findByTestId("or-run-workspace-error")).toBeTruthy();
  });

  it("shows the committed blocked reason and next actor", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/diagnosis") ? json(diagnosis) : json([]));
    renderWorkspace();
    await waitFor(() => expect(screen.getByText(/gate.*operator/i)).toBeTruthy());
  });
});
