import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Assessment } from "../lib/assessment";
import type { EditOutcome } from "../lib/edit-outcome";
import type { ParkedGate } from "../types";
import type { OperatorUnitView } from "../operator-contracts";
import { BuilderHandoffPanel } from "../components/organisms/BuilderHandoffPanel";
import { reviewToGates } from "../adapters/core";
import { invalidateCachedRunUnits } from "../client";
import sample from "../__fixtures__/v2-adapter-sample.json";

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const base: OperatorUnitView = (() => {
  const found = (sample.units as unknown as OperatorUnitView[]).find((unit) => unit.stage === "cohort"
    && unit.decisions.some((decision) => decision.submit.kind === "review" && decision.submit.decision === "request_build_changes"));
  if (!found) throw new Error("captured unit lacks assessment review");
  return found;
})();
const assessment = (id = "a", revision = "assessment-rev"): Assessment => ({
  head_sha: null, verdict: "pass_with_notes", findings: [], test_evidence: null,
  recommended_next_actions: [{ id, text: `Fix ${revision}` }, { id: `${id}-2`, text: "Add coverage" }],
});
function unitFor(revision: string, sent: boolean): OperatorUnitView {
  const artifacts = base.artifacts.map((artifact) => artifact.artifact_key === "assessment"
    ? { ...artifact, latest_revision: artifact.latest_revision ? { ...artifact.latest_revision, id: revision } : null } : artifact);
  const decisions = base.decisions.flatMap((decision) => decision.submit.kind === "review" && decision.submit.review === "assessment_review"
    ? [{ ...decision, submit: { ...decision.submit, target_revision_id: revision } }] : []);
  const recorded_decisions = sent ? [{ id: `sent-${revision}`, review: "assessment_review", decision: "request_build_changes",
    effect: "request_changes" as const, target_revision_id: revision, payload: { feedback: "builder changes" }, created_at: "2026-01-01T00:00:00Z" }] : [];
  return { ...base, run_id: "run-1", unit_id: "unit-a", artifacts, decisions, recorded_decisions };
}
function gateFor(unit: OperatorUnitView): ParkedGate {
  const result = reviewToGates(unit);
  if (!result.ok || !result.value[0]) throw new Error("review gate absent");
  return result.value[0];
}
afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); });
const SAVED: EditOutcome = { ok: true, value: undefined };

function setup(options: { saved?: EditOutcome; revision?: string; actions?: Assessment; hasDecision?: boolean } = {}) {
  let revision = options.revision ?? "assessment-rev";
  let currentAssessment = options.actions ?? assessment();
  let sent = false;
  let unit = unitFor(revision, sent);
  if (options.hasDecision === false) unit = { ...unit, decisions: unit.decisions.filter((decision) => decision.submit.kind !== "review"
    || decision.submit.decision !== "request_build_changes") };
  const posts: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); sent = true; unit = unitFor(revision, sent); return json({ kind: "committed", run_id: "run-1", event_id: `sent-${revision}` }); }
    if (url.endsWith("/units")) return json([unit]);
    if (url.endsWith("/units/unit-a")) return json(unit);
    throw new Error(`unexpected request ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } } });
  const onEdit = vi.fn().mockResolvedValue(options.saved ?? SAVED);
  const onSubmitBody = vi.fn().mockResolvedValue(options.saved ?? SAVED);
  const panel = () => <QueryClientProvider client={client}><BuilderHandoffPanel runId="run-1" unitLabel={base.collection_key ?? base.unit_key} assessment={currentAssessment}
    body={currentAssessment} gate={gateFor(unit)} edit={{ enabled: true, isPending: false, onEdit, onSubmitBody }} /></QueryClientProvider>;
  const view = render(panel());
  return { posts, onSubmitBody, client, supersede: (nextRevision: string) => {
    unit = unitFor(nextRevision, false);
    invalidateCachedRunUnits("run-1");
  }, rerender: (nextAssessment: Assessment, nextRevision: string) => {
    revision = nextRevision; currentAssessment = nextAssessment; sent = false; unit = unitFor(revision, sent);
    invalidateCachedRunUnits("run-1"); void client.invalidateQueries({ queryKey: ["oakridge", "run", "run-1", "sent-feedback"] });
    view.rerender(panel());
  } };
}

describe("assessment builder handoff", () => {
  it("keeps selection attached to IDs after removing and reordering actions", () => {
    const first = assessment();
    const view = setup({ actions: { ...first, recommended_next_actions: [
      { id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }] } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include action 2" }));
    view.rerender({ ...first, recommended_next_actions: [{ id: "c", text: "C" }, { id: "b", text: "B" }] }, "assessment-rev-2");
    expect((screen.getByRole("checkbox", { name: "Include action 2" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Include action 1" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("or-assessment-handoff-preview").textContent).toContain("C");
    expect(screen.getByTestId("or-assessment-handoff-preview").textContent).not.toContain("B");
  });

  it("edits by action identity through a whole-body publication", async () => {
    const view = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit recommended next actions/a/text" }));
    const field = screen.getByDisplayValue("Fix assessment-rev");
    fireEvent.change(field, { target: { value: "Fix revised" } });
    fireEvent.blur(field);
    await waitFor(() => expect(view.onSubmitBody).toHaveBeenCalledWith(assessment(), {
      ...assessment(), recommended_next_actions: [{ id: "a", text: "Fix revised" }, { id: "a-2", text: "Add coverage" }],
    }));
  });

  it("renders a refused removal inline without changing the assessment", async () => {
    setup({ saved: { ok: false, error: "409 stale predecessor" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove action 1" }));
    await screen.findByText(/Not removed: 409 stale predecessor/);
    expect(screen.getByText("Fix assessment-rev")).toBeTruthy();
  });

  it("keeps a refused action edit open with its error", async () => {
    setup({ saved: { ok: false, error: "409 action changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit recommended next actions/a/text" }));
    const field = screen.getByDisplayValue("Fix assessment-rev");
    fireEvent.change(field, { target: { value: "Fix revised" } });
    fireEvent.blur(field);
    await screen.findByText(/Not saved: 409 action changed/);
    expect(screen.getByDisplayValue("Fix revised")).toBeTruthy();
  });

  it("keeps a refused whole-body addition with its error", async () => {
    setup({ saved: { ok: false, error: "409 assessment changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Add recommended next action" }));
    fireEvent.change(screen.getByLabelText("New recommended next action"), { target: { value: "Cover the error path" } });
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    await screen.findByText(/Not saved: 409 assessment changed/);
    expect((screen.getByLabelText("New recommended next action") as HTMLTextAreaElement).value).toBe("Cover the error path");
  });

  it("sends through the real adapter and starts a fresh round without remounting", async () => {
    const view = setup();
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    await screen.findByText("Sent");
    expect(view.posts).toHaveLength(1);
    view.rerender(assessment("fresh", "assessment-rev-2"), "assessment-rev-2");
    await waitFor(() => expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("checkbox", { name: "Include action 1" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    await screen.findByText("Sent");
    expect(view.posts).toHaveLength(2);
  });

  it("disables Send when the decision is not offered", () => {
    setup({ hasDecision: false });
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refetches a superseded review and asks for a new assessment before sending", async () => {
    const view = setup();
    const invalidate = vi.spyOn(view.client, "invalidateQueries");
    view.supersede("assessment-rev-2");
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    await screen.findByText("The assessment changed. Review the new assessment before sending.");
    expect(view.posts).toHaveLength(0);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["oakridge", "run", "run-1", "gates"] });
  });
});
