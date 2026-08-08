import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewInboxView } from "../views/ReviewInboxView";
import type { ReviewInbox } from "../types";
import type { CohortLifecycle } from "../types";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderInbox(data: ReviewInbox, onSelectRun = vi.fn(), onSelectArtifact = vi.fn()) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(json(data));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ReviewInboxView onSelectRun={onSelectRun} onSelectArtifact={onSelectArtifact} /></QueryClientProvider>);
  return { onSelectRun, onSelectArtifact };
}

const inbox: ReviewInbox = {
  cohorts: [{ id: "run-1:api", run_id: "run-1", workflow_name: "dev_flow_v6", stage_instance_id: "stage-build", stage_name: "build", unit_id: "api", title: "Build API", lifecycle: "waiting_admission", completion: { build_complete: false, assessment_complete: false }, admission: { required: true, admitted: false, eligible: true, blocked_by: [] }, artifact_revision_id: null, updated_at: "2026-08-07T00:00:00Z" },
    { id: "run-1:web", run_id: "run-1", workflow_name: "dev_flow_v6", stage_instance_id: "stage-build", stage_name: "build", unit_id: "web", title: "Build UI", lifecycle: "artifact_review", completion: { build_complete: true, assessment_complete: false }, admission: { required: true, admitted: true, eligible: true, blocked_by: [] }, artifact_revision_id: "revision-web", updated_at: "2026-08-07T01:00:00Z" }],
  items: [{ id: "admit-api", kind: "admission", state: "actionable", run_id: "run-1", workflow_name: "dev_flow_v6", stage_instance_id: "stage-build", stage_name: "build", unit_id: "api", lifecycle: "waiting_admission", title: "Build API", resume_actions: [], blocked_by: [] },
    { id: "review-web", kind: "artifact_gate", state: "actionable", run_id: "run-1", workflow_name: "dev_flow_v6", stage_instance_id: "stage-build", stage_name: "build", unit_id: "web", lifecycle: "artifact_review", title: "Build UI", artifact_revision_id: "revision-web", gate_id: "stage-build:web", resume_actions: ["approve", "request_revision"], blocked_by: [] }],
};

afterEach(() => vi.restoreAllMocks());

describe("ReviewInboxView", () => {
  it("renders actionable work and every cohort lifecycle", async () => {
    renderInbox(inbox);
    expect(await screen.findAllByTestId("or-review-inbox-item")).toHaveLength(2);
    expect(screen.getAllByTestId("or-cohort-lifecycle-card")).toHaveLength(2);
    expect(screen.getByText("Waiting for admission")).toBeTruthy();
    expect(screen.getAllByText("Artifact review")).toHaveLength(2);
  });

  it("navigates directly to the reviewed artifact and its run", async () => {
    const handlers = renderInbox(inbox);
    fireEvent.click(await screen.findByTestId("or-inbox-artifact-link"));
    expect(handlers.onSelectArtifact).toHaveBeenCalledWith("revision-web");
    fireEvent.click(screen.getAllByTestId("or-inbox-run-link")[0]);
    expect(handlers.onSelectRun).toHaveBeenCalledWith("run-1");
  });

  it("admits an eligible cohort with an idempotency key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => init?.method === "POST"
      ? json({ stage_instance_id: "stage-build", unit_id: "api", admitted: true })
      : json(inbox));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><ReviewInboxView onSelectRun={() => {}} onSelectArtifact={() => {}} /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId("or-inbox-admit-btn"));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(true));
    const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
    expect(postCall).toBeTruthy();
    if (!postCall) return;
    const [url, init] = postCall;
    expect(String(url)).toContain("/stages/stage-build/units/api/admit");
    const body = JSON.parse(String(init?.body)) as { idempotency_key: string };
    expect(body.idempotency_key).toBeTruthy();
  });

  it("advances an artifact gate directly from the inbox", async () => {
    let resumed = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "POST") {
        resumed = true;
        return json({ gate_id: "stage-build:web", resumed: true });
      }
      return json(resumed
        ? { ...inbox, items: inbox.items.filter((item) => item.id !== "review-web") }
        : inbox);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><ReviewInboxView onSelectRun={() => {}} onSelectArtifact={() => {}} /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId("or-inbox-advance-btn"));
    fireEvent.change(screen.getByTestId("or-resume-comment"), { target: { value: "Artifact is ready" } });
    fireEvent.click(screen.getByTestId("or-resume-submit"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => init?.method === "POST" && String(input).includes("/gates/stage-build%3Aweb/resume"))).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("or-inbox-advance-btn")).toBeNull());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST").length).toBeGreaterThanOrEqual(2);
  });

  it("uses unique form control ids when multiple gate actions are open", async () => {
    renderInbox({
      cohorts: [],
      items: [inbox.items[1], { ...inbox.items[1], id: "review-api", unit_id: "api", title: "Review API", gate_id: "stage-build:api" }],
    });
    for (const button of await screen.findAllByTestId("or-inbox-advance-btn")) fireEvent.click(button);
    const commentFields = screen.getAllByTestId("or-resume-comment") as HTMLTextAreaElement[];
    expect(new Set(commentFields.map((field) => field.id)).size).toBe(2);
  });

  it("shows blockers without offering admission", async () => {
    renderInbox({ cohorts: [], items: [{ ...inbox.items[0], kind: "cohort_blocked", state: "blocked", blocked_by: ["database"] }] });
    expect((await screen.findByTestId("or-review-inbox-blocked")).textContent).toContain("database");
    expect(screen.queryByTestId("or-inbox-admit-btn")).toBeNull();
  });

  it("names every lifecycle state in operator language", async () => {
    const states: CohortLifecycle[] = ["waiting_admission", "building", "artifact_review", "revision_requested", "merge_confirmation", "assessing", "complete", "failed"];
    const labels = ["Waiting for admission", "Building", "Artifact review", "Revision requested", "Merge confirmation", "Assessing", "Done", "Failed"];
    renderInbox({
      items: [],
      cohorts: states.map((lifecycle, index) => ({
        ...inbox.cohorts[0],
        id: `run-1:${index}`,
        unit_id: `cohort-${index}`,
        title: `Cohort ${index}`,
        lifecycle,
      })),
    });
    await screen.findByTestId("or-review-inbox");
    for (const label of labels) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText("Cohort lifecycle (8 total · 7 active)")).toBeTruthy();
  });

  it("labels merge-confirmation work distinctly from artifact review", async () => {
    renderInbox({
      cohorts: [],
      items: [{
        ...inbox.items[1],
        id: "merge-web",
        kind: "merge_confirmation",
        lifecycle: "merge_confirmation",
      }],
    });

    expect((await screen.findAllByText("Merge confirmation")).length).toBeGreaterThanOrEqual(1);
  });
});
