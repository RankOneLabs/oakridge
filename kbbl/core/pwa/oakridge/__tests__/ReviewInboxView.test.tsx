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
  it("puts actionable work first without duplicating it in progress", async () => {
    renderInbox(inbox);
    expect(await screen.findAllByTestId("or-review-inbox-item")).toHaveLength(1);
    expect(screen.queryAllByTestId("or-cohort-lifecycle-card")).toHaveLength(1);
    expect(screen.getByText("Artifact ready for review")).toBeTruthy();
  });

  it("navigates directly to the reviewed artifact and its run", async () => {
    const handlers = renderInbox(inbox);
    fireEvent.click(await screen.findByTestId("or-inbox-artifact-link"));
    expect(handlers.onSelectArtifact).toHaveBeenCalledWith("revision-web");
    fireEvent.click(screen.getAllByTestId("or-inbox-run-link")[0]);
    expect(handlers.onSelectRun).toHaveBeenCalledWith("run-1");
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
    fireEvent.click(await screen.findByTestId("or-decision-approve"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => init?.method === "POST" && String(input).includes("/gates/stage-build%3Aweb/resume"))).toBe(true));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ action: "approve", operator_comment: "Approve artifact", feedback: "" });
    await waitFor(() => expect(screen.queryByTestId("or-decision-approve")).toBeNull());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST").length).toBeGreaterThanOrEqual(2);
  });

  it("requires and submits actionable feedback when requesting changes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => init?.method === "POST"
      ? json({ gate_id: "stage-build:web", resumed: true })
      : json({
      cohorts: [],
      items: [inbox.items[1]],
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><ReviewInboxView onSelectRun={() => {}} onSelectArtifact={() => {}} /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId("or-decision-request_revision"));
    const send = screen.getByRole("button", { name: "Send feedback" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What needs to change?"), { target: { value: "Explain the recovery path." } });
    fireEvent.click(send);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ action: "request_revision", feedback: "Explain the recovery path." });
  });

  it("shows blockers without offering admission", async () => {
    renderInbox({ cohorts: [], items: [{ ...inbox.items[0], kind: "cohort_blocked", state: "blocked", blocked_by: ["database"] }] });
    expect((await screen.findByTestId("or-review-inbox-blocked")).textContent).toContain("database");
    expect(screen.queryByTestId("or-inbox-admit-btn")).toBeNull();
  });

  it("names every lifecycle state in operator language", async () => {
    const states: CohortLifecycle[] = ["waiting_admission", "building", "artifact_review", "revision_requested", "merge_confirmation", "assessing", "github_review", "pull_request_mismatch", "complete", "failed"];
    const labels = ["Brief approved · queued", "Building", "Waiting for your review", "Changes requested", "Waiting for merge confirmation", "Checking the result", "Waiting for GitHub review or merge", "Pull request needs attention", "Needs recovery"];
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
    fireEvent.click(screen.getByText("Finished recently (1)"));
    expect(screen.getByText("Complete")).toBeTruthy();
  });

  it("labels merge-confirmation work distinctly from artifact review", async () => {
    renderInbox({
      cohorts: [],
      items: [{
        ...inbox.items[1],
        id: "merge-web",
        kind: "merge_confirmation",
        lifecycle: "merge_confirmation",
        resume_actions: ["confirm_merged"],
      }],
    });

    expect(await screen.findByText("Confirm the merged pull request")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm merge" })).toBeTruthy();
  });

  it("surfaces pull request mismatches as actionable with reconciliation detail", async () => {
    const mismatchCohort = {
      ...inbox.cohorts[1],
      lifecycle: "pull_request_mismatch" as const,
      pull_request_reconciliation: {
        repository_key: "web",
        observation: { owner: "wrong", name: "web", number: 42, url: "https://github.com/wrong/web/pull/42", head_branch: "cohort/web", base_branch: "main", state: "open" as const, observed_at: "2026-08-08T00:00:00Z" },
        mismatch: { kind: "repository_mismatch" as const, detail: "observed pull request belongs to another repository" },
        completed_at: null,
        updated_at: "2026-08-08T00:00:00Z",
      },
    };
    renderInbox({ cohorts: [mismatchCohort], items: [{ ...inbox.items[1], id: "mismatch-web", kind: "pull_request_mismatch", state: "blocked", lifecycle: "pull_request_mismatch", pr_url: mismatchCohort.pull_request_reconciliation.observation.url }] });
    expect(await screen.findByText("Pull request needs attention")).toBeTruthy();
    expect(screen.getByText("observed pull request belongs to another repository")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open pull request" })).toBeTruthy();
  });

  it("shows automatic merged completion from durable reconciliation", async () => {
    renderInbox({
      items: [],
      cohorts: [{
        ...inbox.cohorts[1],
        lifecycle: "complete",
        pull_request_reconciliation: {
          repository_key: "web",
          observation: { owner: "acme", name: "web", number: 42, url: "https://github.com/acme/web/pull/42", head_branch: "cohort/web", base_branch: "epic/full-parity", state: "merged", observed_at: "2026-08-08T00:00:00Z" },
          mismatch: null,
          completed_at: "2026-08-08T00:00:00Z",
          updated_at: "2026-08-08T00:00:00Z",
        },
      }],
    });
    fireEvent.click(await screen.findByText("Finished recently (1)"));
    expect(screen.getByText("Merged · complete")).toBeTruthy();
  });
});
