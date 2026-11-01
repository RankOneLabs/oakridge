import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { RunListView } from "../views/RunListView";
// Aliased: `RunDetail` is also the name of the run view-model type below.
import { RunDetail as RunDetailOrganism } from "../components/organisms/RunDetail";
import type { RunSummary, RunDetail, ParkedGate, RepositoryKey, CohortId, EpicProfileId, StageUnitParams, WorkflowRunId } from "../types";
import type { BuildBrief } from "../lib/build-brief";
import { compositeId } from "../adapters/core";
import { invalidateCachedRunUnits } from "../client";
import mergeFixture from "../__fixtures__/v2-integration-merge.json";
import { retryUnit, withUnitFields } from "../__fixtures__/read-models";
import type { OperatorUnitView } from "../operator-contracts";

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// ──────────────────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
}

let runsSeed: RunSummary[] | null = null;
let runSeed: RunDetail | null = null;
let runGatesSeed: ParkedGate[] = [];
function wrap(ui: ReactElement) {
  const client = makeClient();
  if (runsSeed) client.setQueryData(["oakridge", "runs", ""], runsSeed);
  if (runSeed) {
    client.setQueryData(["oakridge", "run", runSeed.id], runSeed);
    client.setQueryData(["oakridge", "run", runSeed.id, "gates"], runGatesSeed);
    client.setQueryData(["oakridge", "run", runSeed.id, "sessions"], []);
  }
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); runsSeed = null; runSeed = null; runGatesSeed = []; });

/**
 * A stage unit's `params` is the minted fan-out item (`{unit_id, artifact}`)
 * — a build unit's `artifact` is a `dev.build_brief` body. Fixtures build a
 * full valid BuildBrief rather than the flat ad hoc shape this replaced, so
 * `selectCohortBrief`'s `isBuildBrief` guard accepts them the way it accepts
 * a real one.
 */
function buildBriefParams(overrides: Partial<BuildBrief> = {}): StageUnitParams {
  const artifact: BuildBrief = {
    cohort_id: "cohort-a" as CohortId,
    repository_key: "oakridge" as RepositoryKey,
    title: "Untitled cohort",
    depends_on: [],
    goal: "",
    files_in_scope: [],
    decisions_made: [],
    approaches_rejected: [],
    acceptance_criteria: [],
    next_action: "",
    ...overrides,
  };
  return { unit_id: artifact.cohort_id, artifact };
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const RUN_SUMMARY_FIXTURE: RunSummary = {
  id: "run-1",
  title: "Ship the operator console",
  repository_keys: ["oakridge"],
  workflow_name: "v2_spec_to_ship",
  status: "running",
  current_stage: "build",
  stage_total: 5,
  stage_complete: 2,
  parked_count: 0,
  updated_at: "2026-07-01T10:00:00Z",
  is_stuck: false,
  is_failed: false,
};

const PARKED_RUN_SUMMARY: RunSummary = {
  id: "run-2",
  title: "Repair production auth",
  repository_keys: ["kbbl", "oakridge"],
  workflow_name: "v2_hotfix",
  status: "parked",
  current_stage: "approve",
  stage_total: 4,
  stage_complete: 1,
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
  offered_decisions: ["approve", "reject"],
  run_state: "active",
  actionable: true,
};

const RUN_DETAIL_FIXTURE: RunDetail = {
  id: "run-1",
  title: "Ship the operator console",
  repository_keys: ["oakridge"],
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
    runsSeed = [RUN_SUMMARY_FIXTURE, PARKED_RUN_SUMMARY];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json([RUN_SUMMARY_FIXTURE, PARKED_RUN_SUMMARY]),
    );
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    const rows = await screen.findAllByTestId("or-run-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Ship the operator console")).toBeTruthy();
    expect(screen.getByText("oakridge")).toBeTruthy();
    expect(screen.getByText("kbbl, oakridge")).toBeTruthy();
    expect(screen.queryByTestId("or-global-gate-list")).toBeNull();
  });

  it("lists a running run with outstanding waits on the Parked tab", async () => {
    const runningWithWaits: RunSummary = { ...RUN_SUMMARY_FIXTURE, parked_count: 1 };
    runsSeed = [runningWithWaits, { ...PARKED_RUN_SUMMARY, parked_count: 0 }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(runsSeed));
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    fireEvent.click(screen.getByTestId("or-filter-tab-parked"));
    const rows = await screen.findAllByTestId("or-run-row");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("Ship the operator console")]);
    expect(screen.getByTestId("or-parked-count").textContent).toBe("1");
    expect(rows[0]?.textContent).toContain("running");
  });

  it("keeps pending, running, and parked runs on the Active tab", async () => {
    runsSeed = [RUN_SUMMARY_FIXTURE, PARKED_RUN_SUMMARY,
      { ...RUN_SUMMARY_FIXTURE, id: "run-3", title: "Queued work", status: "pending" },
      { ...RUN_SUMMARY_FIXTURE, id: "run-4", title: "Finished work", status: "complete" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(runsSeed));
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    fireEvent.click(screen.getByTestId("or-filter-tab-active"));
    expect((await screen.findAllByTestId("or-run-row")).map((row) => row.textContent)).toEqual([
      expect.stringContaining("Ship the operator console"),
      expect.stringContaining("Repair production auth"),
      expect.stringContaining("Queued work"),
    ]);
  });

  it("shows parked_count badge when parked_count > 0", async () => {
    runsSeed = [PARKED_RUN_SUMMARY];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json([PARKED_RUN_SUMMARY]),
    );
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    const badge = await screen.findByTestId("or-parked-count");
    expect(badge.textContent).toBe("2");
  });

  it("uses one status precedence for the visible run state", async () => {
    runsSeed = [{ ...PARKED_RUN_SUMMARY, is_stuck: true }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json([{ ...PARKED_RUN_SUMMARY, is_stuck: true }]),
    );
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    expect(await screen.findByText("stuck")).toBeTruthy();
  });

  it("shows empty state when no runs", async () => {
    runsSeed = [];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([]));
    wrap(<RunListView onSelectRun={() => {}} onNewRun={() => {}} onNewProject={() => {}} />);
    expect(await screen.findByTestId("or-run-list-empty")).toBeTruthy();
  });

  it("calls onSelectRun when a row is clicked", async () => {
    runsSeed = [RUN_SUMMARY_FIXTURE];
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

describe("RunDetail stage list", () => {
  function makeFetch(detail = RUN_DETAIL_FIXTURE, gates: ParkedGate[] = []): FetchHandler {
    runSeed = detail;
    runGatesSeed = gates;
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/gates")) return json(gates);
      if (url.includes("/runs/")) return json(detail);
      return json([]);
    });
  }

  it("announces loading as a status", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);
    expect(screen.getByText("Loading run…").getAttribute("role")).toBe("status");
  });

  it("renders stage rows with name and status", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch());
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);
    const rows = await screen.findAllByTestId("or-stage-row");
    expect(rows).toHaveLength(2);
  });

  it("shows delegated session link for stages with a kbbl sid", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch());
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);
    const link = await screen.findByTestId("or-delegated-session-link");
    expect(link.getAttribute("href")).toContain("aaaabbbbccccdddd");
  });

  it("shows branch and path when worktree metadata is present", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch());
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);
    const branches = await screen.findAllByTestId("or-stage-branch");
    expect(branches.some((b) => b.textContent?.includes("cohort/v2_readiness/3-minimum_v2"))).toBe(true);
    const paths = await screen.findAllByTestId("or-stage-path");
    expect(paths.some((p) => p.textContent?.includes("/code/oakridge"))).toBe(true);
  });

  it("shows parked gates section when gates exist", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch(RUN_DETAIL_FIXTURE, [PARKED_GATE_FIXTURE]));
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);
    expect(await screen.findByTestId("or-run-gate-list")).toBeTruthy();
    expect(await screen.findByTestId("or-gate-card")).toBeTruthy();
  });

  it("shows error state when run fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "not found" }, 404));
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);
    expect((await screen.findByTestId("or-run-detail-error")).getAttribute("role")).toBe("alert");
  });

  it("keeps full cohort briefs out of the stage list", async () => {
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
          gate: null, is_retryable: false,
          params: buildBriefParams({
            title: "Build the cohort UI",
            goal: "Operator workflow",
            next_action: "Expose the materialized cohort brief.",
            files_in_scope: ["kbbl/core/pwa/oakridge"],
            decisions_made: [{ decision: "Reuse the run table", rationale: "Avoids a second table" }],
            acceptance_criteria: ["Review is explicit"],
            depends_on: ["spec"],
            repository_key: "oakridge" as RepositoryKey,
          }),
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
    runSeed = detail;

    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);

    expect(await screen.findByText("Build the cohort UI")).toBeTruthy();
    expect(screen.queryByText("Operator workflow")).toBeNull();
    expect(screen.queryByText("kbbl/core/pwa/oakridge")).toBeNull();
    expect(screen.queryByText("Review is explicit")).toBeNull();
  });

  it("shows cohort dependencies", async () => {
    const buildUnit = {
      unit_id: "cohort-b",
      repository_key: null,
      sid: null,
      worktree: null,
      is_retryable: false,
      status: "pending" as const,
      gate: null,
      params: buildBriefParams({ title: "Blocked cohort", depends_on: ["cohort-a", "schema-review"] }),
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
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);

    expect((await screen.findByTestId("or-dependencies")).textContent).toContain("cohort-a");
  });

  it("retries a failed build unit without restarting the run", async () => {
    const unit = retryUnit("cohort-a");
    const stageId = compositeId({ kind: "stage", runId: "run-1", unitId: unit.unit_id, name: "cohort" });
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      status: "parked",
      is_stuck: false,
      stages: [{
        stage_instance_id: stageId, name: "build", type: "delegated_session",
        status: "parked", artifacts: [], delegated_kbbl_sid: null, worktree: null,
        units: [{
          unit_id: "cohort-a", repository_key: "oakridge" as RepositoryKey, sid: null, worktree: null,
          status: "failed", gate: null, is_retryable: true, params: buildBriefParams({ title: "Failed build" }),
        }],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/units")) return json([unit]);
      if (url.endsWith("/workers/builder/retry")) return json({ kind: "committed", run_id: "run-1", event_id: "retry-1" }, 201);
      if (url.includes("/gates")) return json([]);
      return json(detail);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    runSeed = detail;
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);

    fireEvent.click(await screen.findByTestId("or-retry-unit-btn"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/oakridge/api/api/runs/run-1/units/${encodeURIComponent(unit.unit_id)}/workers/builder/retry`,
      expect.objectContaining({ method: "POST", body: expect.stringContaining("request_id") }),
    ));
  });

  it("offers unit retry for a stuck run's unfinished unit even when nothing is parked", async () => {
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      status: "running",
      is_stuck: true,
      stages: [{
        stage_instance_id: "build-stage-1", name: "build", type: "delegated_session",
        status: "running", artifacts: [], delegated_kbbl_sid: null, worktree: null,
        units: [{
          unit_id: "cohort-a", repository_key: "oakridge" as RepositoryKey, sid: null, worktree: null,
          status: "running", gate: null, is_retryable: true, params: buildBriefParams({ title: "Rejected build" }),
        }],
      }],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch(detail));
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);

    await screen.findByText("Rejected build");
    expect(screen.queryByTestId("or-retry-unit-btn")).not.toBeNull();
  });

  it("offers no retry for a stuck run's unit that is only waiting on its dependencies", async () => {
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      status: "running",
      is_stuck: true,
      stages: [{
        stage_instance_id: "build-stage-1", name: "build", type: "delegated_session",
        status: "running", artifacts: [], delegated_kbbl_sid: null, worktree: null,
        units: [{
          unit_id: "cohort-b", repository_key: "oakridge" as RepositoryKey, sid: null, worktree: null,
          status: "pending", gate: null, is_retryable: false, params: buildBriefParams({ title: "Waiting build" }),
        }],
      }],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch(detail));
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);

    await screen.findByText("Waiting build");
    expect(screen.queryByTestId("or-retry-unit-btn")).toBeNull();
  });

  it("retries a failed analysis author from its collapsed stage row", async () => {
    const unit = withUnitFields(retryUnit("analysis"), { stage: "analysis", collection_key: null,
      decisions: [{ key: "retry:author", label: "Retry author", payload_schema: "{}", fields: [], submit: { kind: "retry", worker: "author" } }] });
    const stageId = compositeId({ kind: "stage", runId: "run-1", unitId: unit.unit_id, name: "analysis" });
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      status: "running",
      is_stuck: true,
      stages: [{
        stage_instance_id: stageId, name: "analysis", type: "analysis",
        status: "failed", artifacts: [], delegated_kbbl_sid: null, worktree: null,
        units: [{ unit_id: "0", repository_key: null, sid: null, worktree: null, status: "failed", gate: null, is_retryable: true, params: null }],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/units")) return json([unit]);
      if (url.endsWith("/workers/author/retry")) return json({ kind: "committed", run_id: "run-1", event_id: "retry-author" }, 201);
      if (url.includes("/gates")) return json([]);
      return json(detail);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    runSeed = detail;
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);

    fireEvent.click(await screen.findByTestId("or-retry-unit-btn"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/oakridge/api/api/runs/run-1/units/${encodeURIComponent(unit.unit_id)}/workers/author/retry`,
      expect.objectContaining({ method: "POST", body: expect.stringContaining("request_id") }),
    ));
  });

  it("retries the single unit hidden behind a collapsed stage row", async () => {
    const unit = retryUnit("0");
    const stageId = compositeId({ kind: "stage", runId: "run-1", unitId: unit.unit_id, name: "cohort" });
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      status: "running",
      is_stuck: true,
      stages: [{
        stage_instance_id: stageId, name: "brief_writer", type: "artifact_collection",
        status: "running", artifacts: [], delegated_kbbl_sid: null, worktree: null,
        units: [{ unit_id: "0", repository_key: null, sid: null, worktree: null, status: "running", gate: null, is_retryable: true, params: null }],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/units")) return json([unit]);
      if (url.endsWith("/workers/builder/retry")) return json({ kind: "committed", run_id: "run-1", event_id: "retry-brief-writer" }, 201);
      if (url.includes("/gates")) return json([]);
      return json(detail);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    runSeed = detail;
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);

    fireEvent.click(await screen.findByTestId("or-retry-unit-btn"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/oakridge/api/api/runs/run-1/units/${encodeURIComponent(unit.unit_id)}/workers/builder/retry`,
      expect.objectContaining({ method: "POST", body: expect.stringContaining("request_id") }),
    ));
  });

  it("offers unit retry when executor startup failed before the stage could park", async () => {
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      status: "running",
      is_stuck: false,
      stages: [{
        stage_instance_id: "build-stage-1", name: "build", type: "delegated_session",
        status: "running", artifacts: [], delegated_kbbl_sid: null, worktree: null,
        units: [{
          unit_id: "cohort-a", repository_key: "oakridge" as RepositoryKey, sid: null, worktree: null,
          status: "failed", gate: null, is_retryable: true, params: buildBriefParams({ title: "Failed build" }),
        }],
      }],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch(detail));
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);

    await screen.findByText("Failed build");
    expect(screen.queryByTestId("or-retry-unit-btn")).not.toBeNull();
  });

  it("does not offer unit retry after the run is terminal", async () => {
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      status: "failed",
      is_stuck: false,
      stages: [{
        stage_instance_id: "build-stage-1", name: "build", type: "delegated_session",
        status: "failed", artifacts: [], delegated_kbbl_sid: null, worktree: null,
        units: [{
          unit_id: "cohort-a", repository_key: "oakridge" as RepositoryKey, sid: null, worktree: null,
          status: "failed", gate: null, is_retryable: true, params: buildBriefParams({ title: "Failed build" }),
        }],
      }],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch(detail));
    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);

    await screen.findByText("Failed build");
    expect(screen.queryByTestId("or-retry-unit-btn")).toBeNull();
  });

  it("shows final integration and explicitly confirms external completion", async () => {
    const repositoryKey = "oakridge" as RepositoryKey;
    const capturedIntegration = (mergeFixture.units as unknown as OperatorUnitView[]).find((unit) => unit.stage === "integration" && unit.decisions.some((decision) => decision.key === "confirm_merged"));
    if (!capturedIntegration) throw new Error("captured fixture lacks integration merge review");
    const integrationUnit = withUnitFields(capturedIntegration, { run_id: "run-1", collection_key: repositoryKey });
    const detail: RunDetail = {
      ...RUN_DETAIL_FIXTURE,
      epic_profile: {
        id: "epic-1" as EpicProfileId,
        workflow_run_id: "run-1" as WorkflowRunId,
        title: "V2 parity",
        slug: "v2-parity",
        lifecycle_state: "final_integration",
        final_merge_policy: "external_confirmation",
        base_branch: "epic/v2-parity",
        repositories: [{
          repository_key: repositoryKey,
          repository_path: "/code/oakridge",
          integration_branch: "main",
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
          integration_branch: "main",
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
      if (url.endsWith("/units")) return json([integrationUnit]);
      if (url.endsWith("/reviews/merge_confirmation/decide")) {
        expect(init?.method).toBe("POST");
        return json({ kind: "committed", run_id: "run-1", event_id: "merge-confirmed" }, 201);
      }
      if (url.includes("/gates")) return json([]);
      if (url.includes("/runs/")) return json(detail);
      return json([]);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    runSeed = detail;

    wrap(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />);

    expect(await screen.findByTestId("or-final-integration")).toBeTruthy();
    expect(screen.getAllByText("epic/v2-parity")).toHaveLength(2);
    expect(screen.getAllByText("main")).toHaveLength(2);
    expect(screen.queryByTestId("or-confirm-final-docs")).toBeNull();
    fireEvent.click(screen.getByTestId("or-confirm-final-oakridge"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/oakridge/api/api/runs/run-1/units/${encodeURIComponent(integrationUnit.unit_id)}/reviews/merge_confirmation/decide`,
      expect.objectContaining({ method: "POST" }),
    ));
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
