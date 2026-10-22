import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GateDecisionActions } from "../components/organisms/GateDecisionActions";
import { invalidateCachedRunUnits } from "../client";
import sample from "../__fixtures__/v2-adapter-sample.json";
import mergeFixture from "../__fixtures__/v2-cohort-merge.json";
import type { OperatorUnitView } from "../operator-contracts";
import type { ParkedGate, RepositoryKey, RunState } from "../types";
import { compositeId, reviewToGates } from "../adapters/core";

function gate(id: string, revision: string, overrides: Partial<Pick<ParkedGate, "run_state" | "actionable">> = {}): ParkedGate {
  return {
    id,
    gate_type: "artifact_approval",
    gate_step: "artifact_approval",
    run_id: "run-1",
    stage_name: "build",
    unit_id: "web",
    repository_key: "web" as RepositoryKey,
    artifact_revision_id: revision,
    worktree: null,
    resume_actions: ["approve", "request_build_changes"],
    pr_url: null,
    run_state: "active",
    actionable: true,
    ...overrides,
  };
}

function wrapper(client: QueryClient, value: ParkedGate, onComplete = vi.fn(), artifactRevisionId?: string) {
  return (
    <QueryClientProvider client={client}>
      <GateDecisionActions gate={value} artifactRevisionId={artifactRevisionId} onComplete={onComplete} />
    </QueryClientProvider>
  );
}

afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const capturedCohort = (sample.units as unknown as OperatorUnitView[]).find((unit) => unit.stage === "cohort" && unit.decisions.some((decision) => decision.submit.kind === "review" && decision.submit.review === "assessment_review"));
if (!capturedCohort) throw new Error("captured fixture lacks an assessment review");
const unitFor = (unitId: string, revision: string) => ({ ...capturedCohort, run_id: "run-1", unit_id: unitId,
  decisions: capturedCohort.decisions.flatMap((decision) => {
    if (decision.submit.kind !== "review" || decision.submit.review !== "assessment_review") return [];
    return [{ ...decision, submit: { ...decision.submit, target_revision_id: revision } }];
  }) });
function mockV2(units: readonly ReturnType<typeof unitFor>[], post: (init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    if (init?.method === "POST") return post(init);
    if (path.includes("/api/runs?")) return json({ items: [{ ...sample.run, run_id: "run-1" }], next_cursor: null });
    if (path.endsWith("/units")) return json(units);
    const unit = units.find((candidate) => path.endsWith(`/units/${candidate.unit_id}`));
    if (unit) return json(unit);
    throw new Error(`unexpected v2 request ${path}`);
  });
}

const mergeUnit = (mergeFixture.units as unknown as OperatorUnitView[]).find((unit) =>
  unit.decisions.some((decision) => decision.submit.kind === "review" && decision.submit.review === "merge_confirmation"));
if (!mergeUnit) throw new Error("captured fixture lacks a merge confirmation");
const confirmedMergeUnit: OperatorUnitView = mergeUnit;
const mergeGates = reviewToGates(confirmedMergeUnit);
if (!mergeGates.ok) throw new Error("captured merge review could not be mapped");
const mergeGate = mergeGates.value.find((candidate) => candidate.gate_step === "merge_confirmation");
if (!mergeGate) throw new Error("captured fixture lacks a merge gate");

function mockMerge(status: unknown, post: (init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith("/merge-status")) return json(status);
    if (init?.method === "POST") return post(init);
    if (path.endsWith(`/units/${encodeURIComponent(confirmedMergeUnit.unit_id)}`)) return json(confirmedMergeUnit);
    throw new Error(`unexpected merge request ${path}`);
  });
}

describe("GateDecisionActions", () => {
  it("checks the live PR and warns before allowing an override for an open PR", async () => {
    const fetchMock = mockMerge({ kind: "not_merged", pr_url: mergeGate.pr_url, state: "open" }, async () =>
      json({ kind: "committed", run_id: mergeGate.run_id, event_id: "decided" }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(wrapper(client, mergeGate));

    fireEvent.click(screen.getByTestId("or-decision-confirm_merged"));
    expect((await screen.findByTestId("or-merge-warning")).textContent).toContain("still open");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm anyway" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(screen.getByTestId("or-decision-success").textContent).toContain("operator override");
  });

  it("confirms directly when the live PR status is merged", async () => {
    const fetchMock = mockMerge({ kind: "merged", pr_url: mergeGate.pr_url, merged_at: "2026-10-21T00:00:00Z" }, async () =>
      json({ kind: "committed", run_id: mergeGate.run_id, event_id: "decided" }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(wrapper(client, mergeGate));

    fireEvent.click(screen.getByTestId("or-decision-confirm_merged"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(screen.queryByTestId("or-merge-warning")).toBeNull();
  });

  it("warns and keeps manual override available when the PR reader is unavailable", async () => {
    const fetchMock = mockMerge({ kind: "unavailable", detail: "reader down" }, async () =>
      json({ kind: "committed", run_id: mergeGate.run_id, event_id: "decided" }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(wrapper(client, mergeGate));

    fireEvent.click(screen.getByTestId("or-decision-confirm_merged"));
    expect((await screen.findByTestId("or-merge-warning")).textContent).toContain("reader down");
    expect(screen.getByRole("button", { name: "Confirm anyway" })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("submits the latest edited artifact revision", async () => {
    let requestBody: { target: string } | undefined;
    mockV2([unitFor("unit-a", "revision-edited")], async (init) => {
      requestBody = JSON.parse(String(init?.body)) as { target: string };
      return json({ kind: "committed", run_id: "run-1", event_id: "decided" });
    });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(wrapper(client, gate("gate-a", "revision-root"), vi.fn(), "revision-edited"));

    fireEvent.click(screen.getByTestId("or-decision-approve"));
    await waitFor(() => expect(requestBody?.target).toBe("revision-edited"));
  });

  it("resets decision state on a gate switch and ignores the previous gate response", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetchMock = mockV2([unitFor("unit-a", "revision-a"), unitFor("unit-b", "revision-b")],
      () => new Promise<Response>((resolve) => { resolveRequest = resolve; }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const onComplete = vi.fn();
    const view = render(wrapper(client, gate("gate-a", "revision-a"), onComplete));

    fireEvent.click(screen.getByTestId("or-decision-approve"));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    const staleResponseResolver = resolveRequest;
    if (!staleResponseResolver) throw new Error("Expected an in-flight request for gate-a");
    view.rerender(wrapper(client, gate("gate-b", "revision-b"), onComplete));
    await waitFor(() => expect(screen.getByTestId("or-decision-approve")).toBeTruthy());

    await act(async () => {
      staleResponseResolver(json({ kind: "committed", run_id: "run-1", event_id: "decided" }));
    });

    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.queryByTestId("or-decision-success")).toBeNull();
    expect(screen.getByTestId("or-decision-approve")).toBeTruthy();
  });

  it("uses a new idempotency key when feedback changes", async () => {
    const requests: Array<{ payload: { feedback: string }; request_id: string }> = [];
    mockV2([unitFor("unit-a", "revision-a")], async (init) => {
      requests.push(JSON.parse(String(init?.body)) as { payload: { feedback: string }; request_id: string });
      return json({ detail: "try again" }, 500);
    });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(wrapper(client, gate(compositeId({ kind: "gate", runId: "run-1", unitId: "unit-a", name: "assessment_review" }), "revision-a")));

    fireEvent.click(screen.getByTestId("or-decision-request_build_changes"));
    fireEvent.change(screen.getByLabelText("What needs to change?"), { target: { value: "First explanation" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await screen.findByRole("alert");

    fireEvent.change(screen.getByLabelText("What needs to change?"), { target: { value: "Better explanation" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(requests).toHaveLength(2));

    expect(requests.map((request) => request.payload.feedback)).toEqual(["First explanation", "Better explanation"]);
    expect(requests[0].request_id).not.toBe(requests[1].request_id);
  });

  it("renders a stranded gate as visible, but with every decision disabled and no feedback textarea reachable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ gate_id: "gate-a", resumed: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const runState: RunState = "cancelled";
    render(wrapper(client, gate("gate-a", "revision-a", { run_state: runState, actionable: false })));

    const stranded = screen.getByTestId("or-gate-stranded");
    expect(stranded.textContent).toBe("Run cancelled — gate stranded");
    expect((screen.getByTestId("or-decision-approve") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("or-decision-request_build_changes") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("or-decision-request_build_changes"));
    expect(screen.queryByTestId("or-decision-feedback")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes an already-open feedback panel when the gate becomes non-actionable", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const view = render(wrapper(client, gate("gate-a", "revision-a")));

    fireEvent.click(screen.getByTestId("or-decision-request_build_changes"));
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeTruthy();

    view.rerender(wrapper(client, gate("gate-a", "revision-a", { actionable: false })));

    expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();
  });
});
