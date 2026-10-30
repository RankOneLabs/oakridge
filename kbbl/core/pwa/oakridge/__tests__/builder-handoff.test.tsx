import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ParkedGate } from "../types";
import type { Assessment } from "../lib/assessment";
import type { EditOutcome } from "../lib/edit-outcome";
import { BuilderHandoffPanel } from "../components/organisms/BuilderHandoffPanel";
import { compositeId } from "../adapters/core";
import { invalidateCachedRunUnits } from "../client";
import sample from "../__fixtures__/v2-adapter-sample.json";
import type { OperatorUnitView } from "../operator-contracts";

// Split out of artifact-review.test.tsx: the handoff panel is tested on its own,
// and the review only needs to show it on the latest editable revision.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); });

const HANDOFF_ASSESSMENT: Assessment = {
  head_sha: null, verdict: "pass_with_notes", findings: [], test_evidence: null,
  recommended_next_actions: ["Fix the first issue", "Add coverage"],
};
const HANDOFF_GATE: ParkedGate = {
  id: compositeId({ kind: "gate", runId: "run-1", unitId: "unit-a", name: "assessment_review" }),
  gate_type: "assessment_review",
  gate_step: "assessment_review",
  run_id: "run-1",
  stage_name: "cohort",
  unit_id: "alpha",
  artifact_revision_id: "assessment-rev",
  worktree: null,
  resume_actions: ["approve", "request_assessment_changes"],
  run_state: "active",
  actionable: true,
};
const capturedCohort = (sample.units as unknown as OperatorUnitView[]).find((unit) => unit.stage === "cohort"
  && unit.decisions.some((decision) => decision.submit.kind === "review" && decision.submit.decision === "request_build_changes"));
if (!capturedCohort) throw new Error("captured fixture lacks a build change decision");
// The assessment review's decisions, re-aimed at this test's assessment revision.
const HANDOFF_UNIT = { ...capturedCohort, run_id: "run-1", unit_id: "unit-a",
  decisions: capturedCohort.decisions.flatMap((decision) => decision.submit.kind === "review" && decision.submit.review === "assessment_review"
    ? [{ ...decision, submit: { ...decision.submit, target_revision_id: "assessment-rev" } }] : []) };

/** Serves the unit a decision reads, and hands each POST to `post`. */
function mockDecide(post: (url: string, init: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (init?.method === "POST") return post(String(input), init);
    if (String(input).endsWith("/units/unit-a")) return json(HANDOFF_UNIT);
    throw new Error(`unexpected request ${String(input)}`);
  });
}

const SAVED: EditOutcome = { ok: true, value: undefined };

function renderHandoff({ gate = HANDOFF_GATE, saved = SAVED }: { gate?: ParkedGate | null; saved?: EditOutcome } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const onEdit = vi.fn().mockResolvedValue(saved);
  const onSubmitBody = vi.fn().mockResolvedValue(saved);
  const panel = (current: ParkedGate | null) => <QueryClientProvider client={client}><BuilderHandoffPanel assessment={HANDOFF_ASSESSMENT}
    body={HANDOFF_ASSESSMENT} gate={current}
    edit={{ enabled: true, isPending: false, onEdit, onSubmitBody }} /></QueryClientProvider>;
  const { rerender } = render(panel(gate));
  return { onEdit, onSubmitBody, showGate: (next: ParkedGate | null) => rerender(panel(next)) };
}

describe("assessment builder handoff", () => {
  it("unticks without publishing, then records the exact preview as a build change request", async () => {
    const posts: Array<{ readonly url: string; readonly body: unknown }> = [];
    const fetch = mockDecide(async (url, init) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ kind: "committed", run_id: "run-1", event_id: "event-1" });
    });
    renderHandoff();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include action 2" }));
    const preview = screen.getByTestId("or-assessment-handoff-preview").textContent;
    expect(preview).toBe("Recommended next actions for the builder:\n\n1. Fix the first issue");
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    await screen.findByText("Sent");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).not.toContain("/input");
    expect(posts[0]?.body).toMatchObject({ decision: "request_build_changes", payload: { feedback: preview } });
  });

  it("submits an anchor edit and a whole-body removal through distinct handles", () => {
    const { onEdit, onSubmitBody } = renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Edit recommended next actions/0" }));
    const input = screen.getByDisplayValue("Fix the first issue");
    fireEvent.change(input, { target: { value: "Fix the revised issue" } });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenCalledWith("/recommended_next_actions/0", "Fix the first issue", "Fix the revised issue");
    fireEvent.click(screen.getByRole("button", { name: "Remove action 2" }));
    expect(onSubmitBody).toHaveBeenCalledWith(HANDOFF_ASSESSMENT,
      { ...HANDOFF_ASSESSMENT, recommended_next_actions: ["Fix the first issue"] });
  });

  it("adds an action the assessor missed as a new assessment revision", () => {
    const { onSubmitBody } = renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Add recommended next action" }));
    fireEvent.change(screen.getByLabelText("New recommended next action"), { target: { value: "  Cover the error path  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    expect(onSubmitBody).toHaveBeenCalledWith(HANDOFF_ASSESSMENT,
      { ...HANDOFF_ASSESSMENT, recommended_next_actions: ["Fix the first issue", "Add coverage", "Cover the error path"] });
  });

  it("blocks send when the revision has no open assessment review", () => {
    renderHandoff({ gate: null });
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/no open assessment review/)).toBeTruthy();
  });

  it("blocks send when the run has moved on", () => {
    renderHandoff({ gate: { ...HANDOFF_GATE, actionable: false } });
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/can no longer take a decision/)).toBeTruthy();
  });

  it("blocks send when every action is excluded", () => {
    renderHandoff();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include action 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include action 2" }));
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Include at least one next action/)).toBeTruthy();
  });

  it("retries a rejected send with the same request id", async () => {
    const requestIds: unknown[] = [];
    let attempts = 0;
    mockDecide(async (_url, init) => {
      requestIds.push((JSON.parse(String(init.body)) as { request_id: unknown }).request_id);
      attempts += 1;
      return attempts === 1 ? json({ detail: "try again" }, 500) : json({ kind: "committed", run_id: "run-1", event_id: "event-1" });
    });
    renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    await screen.findByText(/try again|500/);
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    await screen.findByText("Sent");
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
  });

  it("offers a fresh send once the reassessment opens a new review", async () => {
    mockDecide(async () => json({ kind: "committed", run_id: "run-1", event_id: "event-1" }));
    const { showGate } = renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    await screen.findByText("Sent");
    showGate(null);
    expect(screen.getByText("Sent")).toBeTruthy();
    showGate({ ...HANDOFF_GATE, id: "reassessment-gate", artifact_revision_id: "reassessment-rev" });
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps a new action and says why when saving it is refused", async () => {
    renderHandoff({ saved: { ok: false, error: "409 stale revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Add recommended next action" }));
    fireEvent.change(screen.getByLabelText("New recommended next action"), { target: { value: "Cover the error path" } });
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    await screen.findByText(/Not saved: 409 stale revision/);
    expect((screen.getByLabelText("New recommended next action") as HTMLTextAreaElement).value).toBe("Cover the error path");
  });

  it("keeps an edited action open when saving it is refused", async () => {
    renderHandoff({ saved: { ok: false, error: "409 stale revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit recommended next actions/0" }));
    const input = screen.getByDisplayValue("Fix the first issue");
    fireEvent.change(input, { target: { value: "Fix the revised issue" } });
    fireEvent.blur(input);
    await screen.findByText(/Not saved: 409 stale revision/);
    expect(screen.getByDisplayValue("Fix the revised issue")).toBeTruthy();
  });
});
