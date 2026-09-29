import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { RunListView } from "../views/RunListView";
// Aliased: `RunDetail` is also the name of the run view-model type below.
import { RunDetail as RunDetailOrganism } from "../components/organisms/RunDetail";
import { GlobalParkedGateList } from "../components/organisms/ParkedGateList";
import type { RunSummary, RunDetail, ParkedGate } from "../types";

// ──────────────────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrap(ui: ReactElement) {
  const client = makeClient();
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

/**
 * A stage unit's `params` is the minted fan-out item (`{unit_id, artifact}`)
 * — a build unit's `artifact` is a `dev.build_brief` body. Fixtures build a
 * full valid BuildBrief rather than the flat ad hoc shape this replaced, so
 * `selectCohortBrief`'s `isBuildBrief` guard accepts them the way it accepts
 * a real one.
 */
// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const RUN_SUMMARY_FIXTURE: RunSummary = {
  id: "run-1",
  title: "Ship the operator console",
  repository_keys: ["oakridge"],
  workflow_name: "v2_spec_to_ship",
  status: "active",
  blocked_reason: null,
  next_actor: null,
  current_stage: "build",
  stage_total: 5,
  stage_complete: 2,
  attention_count: 0,
  parked_count: 0,
  updated_at: "2026-07-01T10:00:00Z",
};

const PARKED_RUN_SUMMARY: RunSummary = {
  id: "run-2",
  title: "Repair production auth",
  repository_keys: ["kbbl", "oakridge"],
  workflow_name: "v2_hotfix",
  status: "blocked",
  blocked_reason: "gate",
  next_actor: "operator",
  current_stage: "approve",
  stage_total: 4,
  stage_complete: 1,
  attention_count: 2,
  parked_count: 2,
  updated_at: "2026-07-01T09:00:00Z",
};

const PARKED_GATE_FIXTURE: ParkedGate = {
  id: "gate-1",
  gate_type: "operator_approval",
  gate_step: null,
  run_id: "run-2",
  stage_name: "approve",
  unit_id: "0",
  artifact_revision_id: "rev-abc",
  worktree: { branch: "cohort/v2_readiness/3-foo", path: "/home/steve/codes/rol/oakridge", base_ref: "epic/v2_readiness" },
  resume_actions: ["approve", "reject"],
  run_state: "active",
  actionable: true,
};

const RUN_DETAIL_FIXTURE: RunDetail = {
  id: "run-1",
  title: "Ship the operator console",
  repository_keys: ["oakridge"],
  workflow_name: "v2_spec_to_ship",
  status: "active",
  blocked_reason: null,
  next_actor: "core",
  stages: [
    {
      stage_instance_id: "si-1",
      name: "spec",
      type: "spec_generation",
      status: "complete",
      blocked_reason: null,
      next_actor: null,
      artifacts: [{ id: "art-spec-1", type_id: "spec_v2", version: 1 }],
      delegated_kbbl_sid: null,
      worktree: null,
    },
    {
      stage_instance_id: "si-2",
      name: "build",
      type: "build_agent",
      status: "active",
      blocked_reason: null,
      next_actor: "agent",
      artifacts: [{ id: "art-build-1", type_id: "build_output", version: 1 }],
      delegated_kbbl_sid: "aaaabbbbccccdddd",
      worktree: {
        branch: "cohort/v2_readiness/3-minimum_v2",
        path: "/code/oakridge",
        base_ref: "epic/v2_readiness",
      },
    },
  ],
  parked_count: 0,
  updated_at: "2026-07-01T10:00:00Z",
};

// ──────────────────────────────────────────────────────────────────────────────
// Run list view
// ──────────────────────────────────────────────────────────────────────────────

describe("RunListView", () => {
  it("offers a visible workflow definitions entry point", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([]));
    const onWorkflows = vi.fn();
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} onWorkflows={onWorkflows} />);
    fireEvent.click(await screen.findByTestId("or-workflows-btn"));
    expect(onWorkflows).toHaveBeenCalledOnce();
  });

  it("shows loading state while runs are pending", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    expect(screen.getByTestId("or-run-list-loading")).toBeTruthy();
  });

  it("renders a row for each run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json([RUN_SUMMARY_FIXTURE, PARKED_RUN_SUMMARY]),
    );
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    const rows = await screen.findAllByTestId("or-run-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Ship the operator console")).toBeTruthy();
    expect(screen.getByText("oakridge")).toBeTruthy();
    expect(screen.getByText("kbbl, oakridge")).toBeTruthy();
  });

  it("shows parked_count badge when parked_count > 0", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json([PARKED_RUN_SUMMARY]),
    );
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    const badge = await screen.findByTestId("or-parked-count");
    expect(badge.textContent).toBe("2");
  });

  it("renders the committed blocked run state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json([PARKED_RUN_SUMMARY]),
    );
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    expect(await screen.findByText("blocked")).toBeTruthy();
  });

  it("shows empty state when no runs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([]));
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    expect(await screen.findByTestId("or-run-list-empty")).toBeTruthy();
  });

  it("calls onSelectRun when a row is clicked", async () => {
    const onSelectRun = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([RUN_SUMMARY_FIXTURE]));
    wrap(<RunListView onSelectRun={onSelectRun} onNewRun={() => {}} onNewProject={() => {}} />);
    const row = await screen.findByTestId("or-run-row");
    fireEvent.click(row);
    expect(onSelectRun).toHaveBeenCalledWith("run-1");
  });

  it("shows error state when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: "server down" }, 500),
    );
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    expect(await screen.findByTestId("or-run-list-error")).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Run detail view
// ──────────────────────────────────────────────────────────────────────────────

describe("RunDetail committed diagnosis", () => {
  const detail: RunDetail = {
    ...RUN_DETAIL_FIXTURE,
    status: "blocked",
    blocked_reason: "gate",
    next_actor: "operator",
    stages: [
      {
        ...RUN_DETAIL_FIXTURE.stages[0],
        status: "blocked",
        blocked_reason: "gate",
        next_actor: "operator",
      },
      {
        ...RUN_DETAIL_FIXTURE.stages[1],
        status: "cancelled",
        blocked_reason: null,
        next_actor: null,
      },
    ],
  };

  it("renders typed blocked facts without deriving them", () => {
    wrap(<RunDetailOrganism runId="run-1" run={detail} activeGates={[]} onRunDeleted={() => {}} onSelectArtifact={() => {}} />);
    expect(screen.getByTestId("or-run-detail-blocked-reason").textContent).toContain("gate · next: operator");
    expect(screen.getByTestId("or-stage-blocked-reason").textContent).toContain("gate · next: operator");
  });

  it("keeps a cancelled stage cancelled", () => {
    wrap(<RunDetailOrganism runId="run-1" run={detail} activeGates={[]} onRunDeleted={() => {}} onSelectArtifact={() => {}} />);
    expect(screen.getAllByText("cancelled").length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Global parked gate list
// ──────────────────────────────────────────────────────────────────────────────

describe("GlobalParkedGateList", () => {
  it("renders gate card with type, stage, branch, and path", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([PARKED_GATE_FIXTURE]));
    wrap(<GlobalParkedGateList onNavigateRun={() => {}} />);

    expect(await screen.findByTestId("or-gate-type")).toBeTruthy();
    expect(screen.getByTestId("or-gate-type").textContent).toBe("Operator decision");
    expect(screen.getByTestId("or-gate-stage").textContent).toBe("approve");
    expect(screen.getByTestId("or-gate-branch").textContent).toBe("cohort/v2_readiness/3-foo");
    expect(screen.getByTestId("or-gate-path").textContent).toBe("/home/steve/codes/rol/oakridge");
  });

  it("shows empty state when no gates are parked", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([]));
    wrap(<GlobalParkedGateList onNavigateRun={() => {}} />);
    expect(await screen.findByTestId("or-gate-list-empty")).toBeTruthy();
  });

  it("calls onNavigateRun with the gate's run_id when run link is clicked", async () => {
    const onNavigateRun = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([PARKED_GATE_FIXTURE]));
    wrap(<GlobalParkedGateList onNavigateRun={onNavigateRun} />);
    const runLink = await screen.findByTestId("or-gate-run-link");
    fireEvent.click(runLink);
    expect(onNavigateRun).toHaveBeenCalledWith("run-2");
  });

  it("links a parked gate directly to its review artifact", async () => {
    const onNavigateArtifact = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([PARKED_GATE_FIXTURE]));
    wrap(<GlobalParkedGateList onNavigateRun={() => {}} onNavigateArtifact={onNavigateArtifact} />);
    fireEvent.click(await screen.findByTestId("or-gate-artifact-link"));
    expect(onNavigateArtifact).toHaveBeenCalledWith("rev-abc");
  });

  it("still lists a gate whose run is no longer active, rendered stranded rather than hidden", async () => {
    const strandedGate: ParkedGate = { ...PARKED_GATE_FIXTURE, id: "gate-2", run_state: "failed", actionable: false };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([strandedGate]));
    wrap(<GlobalParkedGateList onNavigateRun={() => {}} />);

    expect(await screen.findByTestId("or-gate-card")).toBeTruthy();
    expect(screen.getByTestId("or-gate-stranded").textContent).toBe("Run failed — gate stranded");
    expect((screen.getByTestId("or-decision-approve") as HTMLButtonElement).disabled).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// OakridgeShell unavailable state (direct hook mock)
// ──────────────────────────────────────────────────────────────────────────────

describe("OakridgeShell unavailable state", () => {
  it("shows unavailable notice when config returns available=false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ available: false }));
    const { OakridgeShell } = await import("../OakridgeShell");
    wrap(<OakridgeShell route={{ sub: "runs" }} />);
    expect(await screen.findByTestId("or-unavailable")).toBeTruthy();
  });
});
