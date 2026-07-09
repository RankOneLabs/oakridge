import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { RunListView } from "../RunListView";
import { RunDetailView } from "../RunDetailView";
import { ArtifactDetailView } from "../ArtifactDetailView";
import { GateResumeForm } from "../GateResumeForm";
import { GlobalParkedGateList } from "../ParkedGateList";
import type { RunSummary, RunDetail, ArtifactDetail, ParkedGate } from "../types";

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const RUN_SUMMARY_FIXTURE: RunSummary = {
  id: "run-1",
  workflow_name: "v2_spec_to_ship",
  status: "running",
  current_stage: "build",
  parked_count: 0,
  updated_at: "2026-07-01T10:00:00Z",
  is_stuck: false,
  is_failed: false,
};

const PARKED_RUN_SUMMARY: RunSummary = {
  id: "run-2",
  workflow_name: "v2_hotfix",
  status: "parked",
  current_stage: "approve",
  parked_count: 2,
  updated_at: "2026-07-01T09:00:00Z",
  is_stuck: false,
  is_failed: false,
};

const PARKED_GATE_FIXTURE: ParkedGate = {
  id: "gate-1",
  gate_type: "operator_approval",
  run_id: "run-2",
  stage_name: "approve",
  artifact_revision_id: "rev-abc",
  worktree: { branch: "cohort/v2_readiness/3-foo", path: "/home/steve/codes/rol/oakridge", base_ref: "epic/v2_readiness" },
  resume_actions: ["approve", "reject"],
};

const RUN_DETAIL_FIXTURE: RunDetail = {
  id: "run-1",
  workflow_name: "v2_spec_to_ship",
  status: "running",
  is_stuck: false,
  stages: [
    {
      stage_instance_id: "si-1",
      name: "spec",
      type: "spec_generation",
      status: "complete",
      artifacts: [{ id: "art-spec-1", type_id: "spec_v2", version: 1 }],
      delegated_kbbl_sid: null,
      worktree: null,
    },
    {
      stage_instance_id: "si-2",
      name: "build",
      type: "build_agent",
      status: "running",
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

const ARTIFACT_FIXTURE: ArtifactDetail = {
  id: "art-1",
  type_id: "spec_v2",
  run_id: "run-1",
  producing_stage: "spec",
  revisions: [
    {
      id: "rev-1",
      status: "approved",
      created_at: "2026-07-01T09:00:00Z",
      body: { title: "Spec body" },
      validation: { valid: true },
    },
  ],
};

// ──────────────────────────────────────────────────────────────────────────────
// Run list view
// ──────────────────────────────────────────────────────────────────────────────

describe("RunListView", () => {
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
  });

  it("shows parked_count badge when parked_count > 0", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json([PARKED_RUN_SUMMARY]),
    );
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    const badge = await screen.findByTestId("or-parked-count");
    expect(badge.textContent).toBe("2");
  });

  it("uses one status precedence for the visible run state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json([{ ...PARKED_RUN_SUMMARY, is_stuck: true }]),
    );
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    expect(await screen.findByText("stuck")).toBeTruthy();
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

describe("RunDetailView", () => {
  function makeFetch(detail = RUN_DETAIL_FIXTURE, gates: ParkedGate[] = []): FetchHandler {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/gates")) return json(gates);
      if (url.includes("/runs/")) return json(detail);
      return json([]);
    });
  }

  it("renders stage rows with name and status", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch());
    wrap(<RunDetailView runId="run-1" onBack={() => {}} onSelectArtifact={() => {}} />);
    const rows = await screen.findAllByTestId("or-stage-row");
    expect(rows).toHaveLength(2);
  });

  it("shows delegated session link for stages with a kbbl sid", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch());
    wrap(<RunDetailView runId="run-1" onBack={() => {}} onSelectArtifact={() => {}} />);
    const link = await screen.findByTestId("or-delegated-session-link");
    expect(link.getAttribute("href")).toContain("aaaabbbbccccdddd");
  });

  it("shows branch and path when worktree metadata is present", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch());
    wrap(<RunDetailView runId="run-1" onBack={() => {}} onSelectArtifact={() => {}} />);
    const branches = await screen.findAllByTestId("or-stage-branch");
    expect(branches.some((b) => b.textContent?.includes("cohort/v2_readiness/3-minimum_v2"))).toBe(true);
    const paths = await screen.findAllByTestId("or-stage-path");
    expect(paths.some((p) => p.textContent?.includes("/code/oakridge"))).toBe(true);
  });

  it("shows parked gates section when gates exist", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch(RUN_DETAIL_FIXTURE, [PARKED_GATE_FIXTURE]));
    wrap(<RunDetailView runId="run-1" onBack={() => {}} onSelectArtifact={() => {}} />);
    expect(await screen.findByTestId("or-run-gate-list")).toBeTruthy();
    expect(await screen.findByTestId("or-gate-card")).toBeTruthy();
  });

  it("shows error state when run fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "not found" }, 404));
    wrap(<RunDetailView runId="run-1" onBack={() => {}} onSelectArtifact={() => {}} />);
    expect(await screen.findByTestId("or-run-detail-error")).toBeTruthy();
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
    expect(screen.getByTestId("or-gate-type").textContent).toBe("operator_approval");
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
});

// ──────────────────────────────────────────────────────────────────────────────
// Gate resume form
// ──────────────────────────────────────────────────────────────────────────────

describe("GateResumeForm", () => {
  it("submit is disabled when operator comment is empty", () => {
    wrap(<GateResumeForm gate={PARKED_GATE_FIXTURE} onDone={() => {}} />);
    const btn = screen.getByTestId("or-resume-submit") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("submit is enabled when operator comment is filled in", async () => {
    wrap(<GateResumeForm gate={PARKED_GATE_FIXTURE} onDone={() => {}} />);
    fireEvent.change(screen.getByTestId("or-resume-comment"), {
      target: { value: "Looks good" },
    });
    const btn = screen.getByTestId("or-resume-submit") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("calls resume endpoint and invokes onDone on success", async () => {
    const onDone = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ gate_id: "gate-1", resumed: true }));
    wrap(<GateResumeForm gate={PARKED_GATE_FIXTURE} onDone={onDone} />);

    fireEvent.change(screen.getByTestId("or-resume-comment"), {
      target: { value: "LGTM — approving build" },
    });
    fireEvent.change(screen.getByTestId("or-resume-feedback"), {
      target: { value: "No further feedback" },
    });
    fireEvent.click(screen.getByTestId("or-resume-submit"));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("shows error message when resume fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "gate already resumed" }, 409));
    wrap(<GateResumeForm gate={PARKED_GATE_FIXTURE} onDone={() => {}} />);

    fireEvent.change(screen.getByTestId("or-resume-comment"), {
      target: { value: "approving" },
    });
    fireEvent.click(screen.getByTestId("or-resume-submit"));

    expect(await screen.findByTestId("or-resume-error")).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Artifact detail view
// ──────────────────────────────────────────────────────────────────────────────

describe("ArtifactDetailView", () => {
  it("renders artifact type, producing stage, and revision body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(ARTIFACT_FIXTURE));
    wrap(<ArtifactDetailView artifactId="art-1" onBack={() => {}} />);

    expect(await screen.findByTestId("or-artifact-type")).toBeTruthy();
    expect(screen.getByTestId("or-artifact-type").textContent).toBe("spec_v2");
    expect(screen.getByTestId("or-artifact-stage").textContent).toBe("spec");

    const body = screen.getByTestId("or-revision-body");
    expect(body.textContent).toContain("Spec body");

    const validation = screen.getByTestId("or-revision-validation");
    expect(validation.textContent).toContain("true");
  });

  it("shows revision status chip", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(ARTIFACT_FIXTURE));
    wrap(<ArtifactDetailView artifactId="art-1" onBack={() => {}} />);
    const status = await screen.findByTestId("or-revision-status");
    expect(status.textContent).toBe("approved");
  });

  it("shows error state when artifact fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "not found" }, 404));
    wrap(<ArtifactDetailView artifactId="bad-id" onBack={() => {}} />);
    expect(await screen.findByTestId("or-artifact-detail-error")).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// OakridgeShell unavailable state (direct hook mock)
// ──────────────────────────────────────────────────────────────────────────────

describe("OakridgeShell unavailable state", () => {
  it("shows unavailable notice when config returns available=false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ available: false }));
    const { OakridgeShell } = await import("../OakridgeShell");
    wrap(
      <OakridgeShell route={{ sub: "runs" }} onBack={() => {}} />,
    );
    expect(await screen.findByTestId("or-unavailable")).toBeTruthy();
  });
});
