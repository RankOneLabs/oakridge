import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { RunDetail as RunDetailOrganism } from "../components/organisms/RunDetail";
import type { RunDetail, RepositoryKey } from "../run-types";
import { compositeId } from "../adapters/core";
import { invalidateCachedRunUnits } from "../client";
import { retryUnit, withUnitFields } from "../__fixtures__/read-models";
import { renderRunView, RUN_DETAIL_FIXTURE, buildBriefParams, json } from "../__fixtures__/run-view";

afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); });

describe("RunDetail unit retry", () => {
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
      if (url.includes("/units?")) return json([unit]);
      if (url.endsWith("/workers/builder/retry")) return json({ kind: "committed", run_id: "run-1", event_id: "retry-1" }, 201);
      if (url.includes("/gates")) return json([]);
      return json(detail);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    renderRunView(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />, { detail });

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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(detail));
    renderRunView(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />, { detail });

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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(detail));
    renderRunView(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />, { detail });

    await screen.findByText("Waiting build");
    expect(screen.queryByTestId("or-retry-unit-btn")).toBeNull();
  });

  it("retries a failed analysis author from its collapsed stage row", async () => {
    const unit = withUnitFields(retryUnit("analysis"), { stage: "analysis", collection_key: null,
      decisions: [{ key: "retry:author", label: "Retry author", payload_schema: "{}", operation: "plain", assessment: null, fields: [], submit: { kind: "retry", worker: "author" } }] });
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
      if (url.includes("/units?")) return json([unit]);
      if (url.endsWith("/workers/author/retry")) return json({ kind: "committed", run_id: "run-1", event_id: "retry-author" }, 201);
      if (url.includes("/gates")) return json([]);
      return json(detail);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    renderRunView(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />, { detail });

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
      if (url.includes("/units?")) return json([unit]);
      if (url.endsWith("/workers/builder/retry")) return json({ kind: "committed", run_id: "run-1", event_id: "retry-brief-writer" }, 201);
      if (url.includes("/gates")) return json([]);
      return json(detail);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    renderRunView(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />, { detail });

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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(detail));
    renderRunView(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />, { detail });

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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(detail));
    renderRunView(<RunDetailOrganism runId="run-1" onRunDeleted={() => {}} onSelectArtifact={() => {}} />, { detail });

    await screen.findByText("Failed build");
    expect(screen.queryByTestId("or-retry-unit-btn")).toBeNull();
  });

});
