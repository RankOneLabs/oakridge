import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewInboxView } from "../views/ReviewInboxView";
import { parseRepositoryKey } from "../repository-inputs";
import type { ReviewInbox } from "../types";
import type { CohortLifecycle } from "../types";
import sample from "../__fixtures__/v2-adapter-sample.json";
import type { OperatorUnitView } from "../operator-contracts";
import { compositeId } from "../adapters/core";

const WEB_REPOSITORY_KEY = parseRepositoryKey("web")!;
const API_REPOSITORY_KEY = parseRepositoryKey("api")!;
const capturedCohort = (sample.units as unknown as OperatorUnitView[]).find((unit) => unit.stage === "cohort" && unit.decisions.some((decision) => decision.submit.kind === "review" && decision.submit.review === "assessment_review"));
if (!capturedCohort) throw new Error("captured fixture lacks an assessment review");
const approveDecision = capturedCohort.decisions.find((decision) => decision.key === "accept");
const legacyBuildChange = capturedCohort.decisions.find((decision) => decision.key === "request_build_changes");
const approveTarget = approveDecision?.submit.kind === "review" ? approveDecision.submit.target_revision_id : null;
if (!legacyBuildChange || legacyBuildChange.submit.kind !== "review") throw new Error("captured fixture lacks legacy assessment decision");
const assessmentChange = { ...legacyBuildChange, key: "request_assessment_changes", label: "Request assessment changes",
  submit: { ...legacyBuildChange.submit, decision: "request_assessment_changes", target_revision_id: approveTarget ?? "" } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderInbox(data: ReviewInbox, onSelectRun = vi.fn(), onSelectArtifact = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["oakridge", "review-inbox"], data);
  render(<QueryClientProvider client={client}><ReviewInboxView onSelectRun={onSelectRun} onSelectArtifact={onSelectArtifact} /></QueryClientProvider>);
  return { onSelectRun, onSelectArtifact };
}

const inbox: ReviewInbox = {
  cohorts: [{ id: "run-1:api", run_id: "run-1", workflow_name: "dev_flow_v6", stage_instance_id: "stage-build", stage_name: "build", unit_id: "api", cohort_key: "api", brief_title: "Build API", repository_key: API_REPOSITORY_KEY, title: "Build API", lifecycle: "building", completion: { build_complete: false, assessment_complete: false }, artifact_revision_id: null, updated_at: "2026-08-07T00:00:00Z" },
    { id: "run-1:web", run_id: "run-1", workflow_name: "dev_flow_v6", stage_instance_id: "stage-build", stage_name: "build", unit_id: "web", cohort_key: "web", brief_title: "Build UI", repository_key: WEB_REPOSITORY_KEY, title: "Build UI", lifecycle: "artifact_review", completion: { build_complete: true, assessment_complete: false }, artifact_revision_id: "revision-web", updated_at: "2026-08-07T01:00:00Z" }],
  items: [{ id: "review-web", kind: "artifact_gate", state: "actionable", run_id: "run-1", workflow_name: "dev_flow_v6", stage_instance_id: "stage-build", stage_name: "build", unit_id: "web", cohort_key: "web", brief_title: "Build UI", repository_key: WEB_REPOSITORY_KEY, lifecycle: "artifact_review", title: "Build UI", artifact_revision_id: approveTarget, gate_id: compositeId({ kind: "gate", runId: "run-1", unitId: capturedCohort.unit_id, name: "assessment_review" }), resume_actions: ["approve", "request_assessment_changes"], blocked_by: [] }],
};

const runId = "run-1";
const v2Unit = { ...capturedCohort, run_id: runId, decisions: [...capturedCohort.decisions, assessmentChange] };
const v2Run = { ...sample.run, run_id: runId };
function v2InboxFetch(items: readonly typeof sample.inbox.items[number][], afterDecision?: () => void) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    if (init?.method === "POST") { afterDecision?.(); return json({ kind: "committed", run_id: runId, event_id: "event-decided" }); }
    if (path.endsWith(`/units/${encodeURIComponent(v2Unit.unit_id)}`)) return json(v2Unit);
    if (path.endsWith("/units")) return json([v2Unit]);
    if (path.includes("/run-inboxes")) return json({ items: [{ run_id: runId, items }] });
    if (path.includes("/api/runs?")) return json({ items: [v2Run], next_cursor: null });
    return json({ items: [] });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("ReviewInboxView", () => {
  it("renders the v2 run-inboxes response through the client and adapter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.includes("/api/runs?")) return json({ items: [sample.run], next_cursor: null });
      if (path.includes("/run-inboxes")) return json({ items: [sample.inbox] });
      if (path.endsWith("/units")) return json(sample.units);
      throw new Error(`unexpected v2 request: ${path}`);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ReviewInboxView onSelectRun={() => {}} onSelectArtifact={() => {}} /></QueryClientProvider>);
    expect(await screen.findByTestId("or-review-inbox")).toBeTruthy();
    expect(screen.getAllByText("Artifact ready for review")).toHaveLength(1);
    expect(screen.queryByTestId("or-decision-request_build_changes")).toBeNull();
    expect(screen.getByTestId("or-decision-approve")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/units"))).toHaveLength(1);
  });

  it("puts actionable work first without duplicating it in progress", async () => {
    renderInbox(inbox);
    expect(await screen.findAllByTestId("or-review-inbox-item")).toHaveLength(1);
    expect(screen.queryAllByTestId("or-cohort-lifecycle-card")).toHaveLength(1);
    expect(screen.getByText("Artifact ready for review")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "web · Build UI · web" })).toBeTruthy();
    expect(screen.getByTestId("or-inbox-repository").textContent).toBe("Repository: web");
  });

  it("keeps separate decisions from one repository visible", async () => {
    const second = { ...inbox.items[0], id: "review-api", unit_id: "api", cohort_key: "api", brief_title: "Build API" };
    renderInbox({ cohorts: [], items: [inbox.items[0], second] });
    expect(await screen.findAllByTestId("or-review-inbox-item")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "web · Build UI · web" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "api · Build API · web" })).toBeTruthy();
  });

  it("explains an empty attention queue", async () => {
    renderInbox({ cohorts: [], items: [] });
    expect((await screen.findByTestId("or-review-inbox-empty")).textContent).toContain("Nothing needs a decision");
  });

  it("distinguishes underway cohorts by brief and repository", async () => {
    renderInbox({
      items: [],
      cohorts: [inbox.cohorts[0], { ...inbox.cohorts[1], lifecycle: "building" }],
    });
    const rows = await screen.findAllByTestId("or-cohort-lifecycle-card");
    expect(rows.map((row) => row.querySelector("strong")?.textContent))
      .toEqual(["api · Build API · api", "web · Build UI · web"]);
  });

  it("does not show a repository chip for an analysis item", async () => {
    renderInbox({ cohorts: [], items: [{ ...inbox.items[0], id: "analysis-review", stage_name: "analysis",
      cohort_key: null, brief_title: null, repository_key: null }] });
    await screen.findByTestId("or-review-inbox-item");
    expect(screen.queryByTestId("or-inbox-repository")).toBeNull();
  });

  it("navigates directly to the reviewed artifact and its run", async () => {
    const handlers = renderInbox(inbox);
    fireEvent.click(await screen.findByTestId("or-inbox-artifact-link"));
    expect(handlers.onSelectArtifact).toHaveBeenCalledWith(approveTarget);
    fireEvent.click(screen.getAllByTestId("or-inbox-run-link")[0]);
    expect(handlers.onSelectRun).toHaveBeenCalledWith("run-1");
  });

  it("advances an artifact gate directly from the inbox", async () => {
    let resumed = false;
    const fetchMock = v2InboxFetch([], () => { resumed = true; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(["oakridge", "review-inbox"], inbox);
    render(<QueryClientProvider client={client}><ReviewInboxView onSelectRun={() => {}} onSelectArtifact={() => {}} /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId("or-decision-approve"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => init?.method === "POST" && String(input).includes(`/units/${encodeURIComponent(v2Unit.unit_id)}/reviews/assessment_review/decide`))).toBe(true));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ decision: "accept", target: approveTarget, payload: {} });
    await waitFor(() => expect(screen.queryByTestId("or-decision-approve")).toBeNull());
    expect(resumed).toBe(true);
  });

  it("requires and submits actionable feedback when requesting changes", async () => {
    const fetchMock = v2InboxFetch([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(["oakridge", "review-inbox"], { cohorts: [], items: [inbox.items[0]] });
    render(<QueryClientProvider client={client}><ReviewInboxView onSelectRun={() => {}} onSelectArtifact={() => {}} /></QueryClientProvider>);
    fireEvent.click(await screen.findByTestId("or-decision-request_assessment_changes"));
    const send = screen.getByRole("button", { name: "Send feedback" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What needs to change?"), { target: { value: "Explain the recovery path." } });
    fireEvent.click(send);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ decision: "request_assessment_changes", target: approveTarget, payload: { feedback: "Explain the recovery path." } });
  });

  it("shows blockers", async () => {
    renderInbox({ cohorts: [], items: [{ ...inbox.items[0], kind: "cohort_blocked", state: "blocked", blocked_by: ["database"] }] });
    expect((await screen.findByTestId("or-review-inbox-blocked")).textContent).toContain("database");
  });

  it("names every lifecycle state in operator language", async () => {
    const states: CohortLifecycle[] = ["building", "artifact_review", "revision_requested", "merge_confirmation", "assessing", "github_review", "pull_request_mismatch", "complete", "failed"];
    const labels = ["Building", "Waiting for your review", "Changes requested", "Waiting for merge confirmation", "Checking the result", "Waiting for GitHub review or merge", "Pull request needs attention", "Needs recovery"];
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
        ...inbox.items[0],
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
        repository_key: WEB_REPOSITORY_KEY,
        observation: { owner: "wrong", name: "web", number: 42, url: "https://github.com/wrong/web/pull/42", head_branch: "cohort/web", base_branch: "main", state: "open" as const, observed_at: "2026-08-08T00:00:00Z" },
        mismatch: { kind: "repository_mismatch" as const, detail: "observed pull request belongs to another repository" },
        completed_at: null,
        updated_at: "2026-08-08T00:00:00Z",
      },
    };
    renderInbox({ cohorts: [mismatchCohort], items: [{ ...inbox.items[0], id: "mismatch-web", kind: "pull_request_mismatch", state: "blocked", lifecycle: "pull_request_mismatch", pr_url: mismatchCohort.pull_request_reconciliation.observation.url }] });
    expect(await screen.findByText("Pull request needs attention")).toBeTruthy();
    expect(screen.getByText("observed pull request belongs to another repository")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open pull request" })).toBeTruthy();
  });

  it("keeps a decided item in place so newly arrived work never slides under the pointer", async () => {
    const briefGate = (id: string, title: string) => ({ ...inbox.items[0], id: `${runId}:${id}:approve`, unit_id: id, cohort_key: id, brief_title: null, repository_key: null, title,
      gate_id: compositeId({ kind: "gate", runId, unitId: id, name: "assessment_review" }), artifact_revision_id: `revision-${id}` });
    const briefA = briefGate("brief-a", "Brief A");
    const briefB = briefGate("brief-b", "Brief B");
    const assessment = briefGate("assessment", "Assessment");
    let decided = false;
    const units = [briefA, briefB, assessment].map((item) => ({ ...v2Unit, unit_id: item.unit_id, collection_key: item.unit_id, label: item.title,
      decisions: v2Unit.decisions.map((decision) => ({ ...decision, submit: { ...decision.submit, target_revision_id: item.artifact_revision_id } })) }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      if (init?.method === "POST") { decided = true; return json({ kind: "committed", run_id: runId, event_id: "event-decided" }); }
      if (path.endsWith("/units")) return json(units);
      if (path.includes("/run-inboxes")) return json({ items: [{ run_id: runId, items: (decided ? [briefB, assessment] : [briefA, briefB]).map((item) => ({
        kind: "decision", run_id: runId, unit_id: item.unit_id, key: "approve", label: "Approve", prompt: null,
        submit: { kind: "review", review: "assessment_review", decision: "approve", effect: "approve", target_revision_id: item.artifact_revision_id },
      })) }] });
      if (path.includes("/api/runs?")) return json({ items: [v2Run], next_cursor: null });
      if (path.includes("/units/")) return json(units.find((unit) => path.endsWith(`/units/${unit.unit_id}`)));
      return json({ items: [] });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(["oakridge", "review-inbox"], { cohorts: [], items: [briefA, briefB] });
    render(<QueryClientProvider client={client}><ReviewInboxView onSelectRun={() => {}} onSelectArtifact={() => {}} /></QueryClientProvider>);
    fireEvent.click((await screen.findAllByTestId("or-decision-approve"))[0]);
    await screen.findByTestId("or-review-inbox-settled-item");
    const rows = screen.getAllByTestId(/^or-review-inbox-(settled-)?item$/)
      .map((row) => `${row.dataset.testid === "or-review-inbox-settled-item" ? "settled" : "live"}:${row.querySelector("h3")?.textContent}`);
    expect(rows).toEqual(["settled:brief-a", "live:brief-b · Cohort a · app", "live:assessment · Cohort a · app"]);
  });

  it("shows automatic merged completion from durable reconciliation", async () => {
    renderInbox({
      items: [],
      cohorts: [{
        ...inbox.cohorts[1],
        lifecycle: "complete",
        pull_request_reconciliation: {
          repository_key: WEB_REPOSITORY_KEY,
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
