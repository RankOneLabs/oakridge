import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { RunListView } from "../views/RunListView";
import { RunDetailView } from "../views/RunDetailView";
import { ArtifactReviewView } from "../views/ArtifactReviewView";
import { GlobalParkedGateList } from "../ParkedGateList";
import type { RunSummary, RunDetail, ArtifactDetail, ParkedGate, RepositoryKey, EpicProfileId, WorkflowRunId } from "../types";

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
  gate_step: null,
  run_id: "run-2",
  stage_name: "approve",
  unit_id: "0",
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
  component_id: null,
  capabilities: null,
  anchor_schema: null,
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
  it("offers a visible review inbox entry point", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([]));
    const onReviewInbox = vi.fn();
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} onReviewInbox={onReviewInbox} />);
    fireEvent.click(await screen.findByTestId("or-review-inbox-btn"));
    expect(onReviewInbox).toHaveBeenCalledOnce();
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

  it("renders a manual admission control when the workflow explicitly requires it", async () => {
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      stages: [{
        stage_instance_id: "build-stage-1",
        name: "build",
        type: "build_agent",
        status: "pending",
        artifacts: [],
        delegated_kbbl_sid: null,
        worktree: null,
        units: [{
          unit_id: "cohort-a",
          repository_key: null,
          sid: null,
          worktree: null,
          status: "pending",
          gate: null,
          admission_required: true,
          admitted: false,
          admission_eligible: true,
          admission_blocked_by: [],
          params: {
            title: "Build the cohort UI",
            scope: "Operator workflow",
            description: "Expose the materialized cohort brief.",
            files_in_scope: ["kbbl/core/pwa/oakridge"],
            decisions: ["Reuse the run table"],
            acceptance_criteria: ["Admission is explicit"],
            depends_on: ["spec"],
            repository_key: "oakridge",
          },
        }],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/gates")) return json([]);
      if (url.includes("/runs/")) return json(detail);
      return json([]);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    wrap(<RunDetailView runId="run-1" onBack={() => {}} onSelectArtifact={() => {}} />);

    expect(await screen.findByText("Build the cohort UI")).toBeTruthy();
    expect(screen.getByText("Admission is explicit")).toBeTruthy();
    expect(screen.getByTestId("or-admit-unit-btn")).toBeTruthy();
  });

  it("shows the exact dependencies blocking build admission", async () => {
    const buildUnit = {
      unit_id: "cohort-b",
      repository_key: null,
      sid: null,
      worktree: null,
      status: "pending" as const,
      gate: null,
      admission_required: true,
      admitted: false,
      admission_eligible: false,
      admission_blocked_by: ["cohort-a", "schema-review"],
      params: { title: "Blocked cohort", depends_on: ["cohort-a", "schema-review"] },
    };
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      stages: [{
        stage_instance_id: "build-stage-1", name: "build", type: "build_agent",
        status: "pending", artifacts: [], delegated_kbbl_sid: null, worktree: null,
        units: [buildUnit],
      }],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch(detail));
    wrap(<RunDetailView runId="run-1" onBack={() => {}} onSelectArtifact={() => {}} />);

    expect((await screen.findByTestId("or-dependency-status")).textContent).toContain("cohort-a: waiting");
    expect(screen.queryByTestId("or-admit-unit-btn")).toBeNull();
  });

  it("retries a failed build unit without restarting the run", async () => {
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      status: "parked",
      is_stuck: false,
      stages: [{
        stage_instance_id: "build-stage-1", name: "build", type: "delegated_session",
        status: "parked", artifacts: [], delegated_kbbl_sid: null, worktree: null,
        units: [{
          unit_id: "cohort-a", repository_key: "oakridge" as RepositoryKey, sid: null, worktree: null,
          status: "failed", gate: null, params: { title: "Failed build" },
        }],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/retry_stuck")) return json({}, 202);
      if (url.includes("/gates")) return json([]);
      return json(detail);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    wrap(<RunDetailView runId="run-1" onBack={() => {}} onSelectArtifact={() => {}} />);

    fireEvent.click(await screen.findByTestId("or-retry-unit-btn"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/oakridge/api/stage_instances/build-stage-1/retry_stuck",
      expect.objectContaining({ body: JSON.stringify({ unit_id: "cohort-a" }) }),
    ));
  });

  it("does not offer unit retry when the failed unit's stage is not parked", async () => {
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      status: "running",
      is_stuck: false,
      stages: [{
        stage_instance_id: "build-stage-1", name: "build", type: "delegated_session",
        status: "running", artifacts: [], delegated_kbbl_sid: null, worktree: null,
        units: [{
          unit_id: "cohort-a", repository_key: "oakridge" as RepositoryKey, sid: null, worktree: null,
          status: "failed", gate: null, params: { title: "Failed build" },
        }],
      }],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch(detail));
    wrap(<RunDetailView runId="run-1" onBack={() => {}} onSelectArtifact={() => {}} />);

    await screen.findByText("Failed build");
    expect(screen.queryByTestId("or-retry-unit-btn")).toBeNull();
  });

  it("shows final integration and explicitly confirms external completion", async () => {
    const repositoryKey = "oakridge" as RepositoryKey;
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      epic_profile: {
        id: "epic-1" as EpicProfileId,
        workflow_run_id: "run-1" as WorkflowRunId,
        title: "V2 parity",
        slug: "v2-parity",
        lifecycle_state: "final_integration",
        final_merge_policy: "external_confirmation",
        repositories: [{
          repository_key: repositoryKey,
          repository_path: "/code/oakridge",
          base_branch: "main",
          epic_branch: "epic/v2-parity",
          forge_repository: { provider: "github", owner: "RankOneLabs", name: "oakridge" },
          final_pull_request: {
            number: 402,
            url: "https://github.com/RankOneLabs/oakridge/pull/402",
            head_branch: "epic/v2-parity",
            base_branch: "main",
          },
          final_merge_state: "awaiting_confirmation",
        }, {
          repository_key: "docs" as RepositoryKey,
          repository_path: "/code/docs",
          base_branch: "main",
          epic_branch: "epic/v2-parity",
          forge_repository: { provider: "github", owner: "RankOneLabs", name: "docs" },
          final_pull_request: {
            number: 17,
            url: "https://github.com/RankOneLabs/docs/pull/17",
            head_branch: "epic/v2-parity",
            base_branch: "main",
          },
          final_merge_state: "pull_request_open",
        }],
        created_at: "2026-08-08T10:00:00Z",
        updated_at: "2026-08-08T11:00:00Z",
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/final_pull_requests/") && url.endsWith("/confirm")) {
        expect(init?.method).toBe("POST");
        return json({ outcome: "completed", profile: { ...detail.epic_profile, lifecycle_state: "completed" } });
      }
      if (url.includes("/gates")) return json([]);
      if (url.includes("/runs/")) return json(detail);
      return json([]);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    wrap(<RunDetailView runId="run-1" onBack={() => {}} onSelectArtifact={() => {}} />);

    expect(await screen.findByTestId("or-final-integration")).toBeTruthy();
    expect(screen.getAllByText("epic/v2-parity")).toHaveLength(2);
    expect(screen.getAllByText("main")).toHaveLength(2);
    expect(screen.queryByTestId("or-confirm-final-docs")).toBeNull();
    fireEvent.click(screen.getByTestId("or-confirm-final-oakridge"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/oakridge/api/workflow_runs/run-1/final_pull_requests/oakridge/confirm",
      expect.objectContaining({ method: "POST" }),
    ));
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
});

// ──────────────────────────────────────────────────────────────────────────────
// Artifact detail view
// ──────────────────────────────────────────────────────────────────────────────

describe("ArtifactReviewView", () => {
  it("renders artifact type, producing stage, and revision body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(ARTIFACT_FIXTURE));
    wrap(<ArtifactReviewView artifactId="art-1" onBack={() => {}} />);

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
    wrap(<ArtifactReviewView artifactId="art-1" onBack={() => {}} />);
    const status = await screen.findByTestId("or-revision-status");
    expect(status.textContent).toBe("approved");
  });

  it("uses the review descriptor layout and action labels for an artifact-local gate", async () => {
    const described: ArtifactDetail = {
      ...ARTIFACT_FIXTURE,
      revisions: [{
        ...ARTIFACT_FIXTURE.revisions[0]!,
        body: { details: "Second", summary: "First" },
      }],
      review: {
        viewer: "json",
        layout: "report",
        sections: ["summary", "details"],
        action_labels: { approve: "Approve discrepancy report" },
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/gates")) return json([{ ...PARKED_GATE_FIXTURE, artifact_revision_id: "rev-1", resume_actions: ["approve"] }]);
      return json(described);
    });
    wrap(<ArtifactReviewView artifactId="art-1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByTestId("or-artifact-detail").getAttribute("data-review-layout")).toBe("report"));
    expect(await screen.findByTestId("or-artifact-gate-actions")).toBeTruthy();
    expect(screen.getByTestId("or-decision-approve").textContent).toContain("Approve discrepancy report");
    const sections = Array.from(screen.getByTestId("or-descriptor-sections").querySelectorAll("[data-artifact-section]"));
    expect(sections.map((section) => section.getAttribute("data-artifact-section"))).toEqual(["summary", "details"]);

  });

  it("loads run-scoped gates and only offers actions for the selected revision", async () => {
    const artifact: ArtifactDetail = {
      ...ARTIFACT_FIXTURE,
      revisions: [
        ARTIFACT_FIXTURE.revisions[0]!,
        { ...ARTIFACT_FIXTURE.revisions[0]!, id: "rev-2", status: "draft" },
      ],
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/runs/run-1/gates")) {
        return json([{ ...PARKED_GATE_FIXTURE, artifact_revision_id: "rev-2" }]);
      }
      return json(artifact);
    });
    wrap(<ArtifactReviewView artifactId="art-1" onBack={() => {}} />);

    await screen.findByTestId("or-artifact-type");
    expect(await screen.findByTestId("or-artifact-gate-actions")).toBeTruthy();
    fireEvent.click(screen.getByTestId("or-rev-tab-0"));
    expect(screen.queryByTestId("or-artifact-gate-actions")).toBeNull();
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes("/runs/run-1/gates"))).toBe(true);
  });

  it("renders configured plan scope and risks", async () => {
    const plan: ArtifactDetail = {
      ...ARTIFACT_FIXTURE,
      component_id: "dev-plan-viewer",
      revisions: [{
        ...ARTIFACT_FIXTURE.revisions[0]!,
        body: { scope: { include: ["core"] }, risks: ["migration"] },
      }],
      review: {
        viewer: "dev-plan-viewer",
        layout: "dag",
        sections: ["scope", "risks"],
        action_labels: {},
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/gates") ? json([]) : json(plan));
    wrap(<ArtifactReviewView artifactId="art-1" onBack={() => {}} />);

    expect(await screen.findByText("Scope")).toBeTruthy();
    expect(screen.getByText("Risks")).toBeTruthy();
    expect(screen.getByText("migration")).toBeTruthy();
  });

  it("shows error state when artifact fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "not found" }, 404));
    wrap(<ArtifactReviewView artifactId="bad-id" onBack={() => {}} />);
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
