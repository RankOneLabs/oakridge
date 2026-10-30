import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { ArtifactReview } from "../components/organisms/ArtifactReview";
import type { ArtifactDetail, ParkedGate } from "../types";
import type { Assessment } from "../lib/assessment";
import { BuilderHandoffPanel } from "../components/organisms/BuilderHandoffPanel";
import { compositeId } from "../adapters/core";
import { invalidateCachedRunUnits } from "../client";
import sample from "../__fixtures__/v2-adapter-sample.json";
import type { OperatorUnitView } from "../operator-contracts";

// Split out of oakridge.test.tsx when the chrome union landed: the review
// organism now has two hosts, and its cases outgrew the shared file.

function wrap(ui: ReactElement, artifact: ArtifactDetail | null = ARTIFACT_FIXTURE, gates: ParkedGate[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  if (artifact) {
    client.setQueryData(["oakridge", "artifact", artifact.id], artifact);
    client.setQueryData(["oakridge", "run", artifact.run_id, "gates"], gates);
    client.setQueryData(["oakridge", "artifact", artifact.id, "threads"], []);
    client.setQueryData(["oakridge", "artifact", artifact.id, "review_items"], []);
  }
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

function renderHandoff(gate: ParkedGate | null = HANDOFF_GATE) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const onEdit = vi.fn();
  const onSubmitBody = vi.fn();
  render(<QueryClientProvider client={client}><BuilderHandoffPanel assessment={HANDOFF_ASSESSMENT}
    body={HANDOFF_ASSESSMENT} gate={gate}
    edit={{ enabled: true, isPending: false, onEdit, onSubmitBody }} /></QueryClientProvider>);
  return { onEdit, onSubmitBody };
}

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
  run_state: "active",
  actionable: true,
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

describe("ArtifactReview", () => {
  it("renders artifact type, producing stage, and revision body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(ARTIFACT_FIXTURE));
    wrap(<ArtifactReview artifactId="art-1" />);

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
    wrap(<ArtifactReview artifactId="art-1" />);
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
    wrap(<ArtifactReview artifactId="art-1" />, described, [{ ...PARKED_GATE_FIXTURE, artifact_revision_id: "rev-1", resume_actions: ["approve"] }]);

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
    wrap(<ArtifactReview artifactId="art-1" />, artifact, [{ ...PARKED_GATE_FIXTURE, artifact_revision_id: "rev-2" }]);

    await screen.findByTestId("or-artifact-type");
    expect(await screen.findByTestId("or-artifact-gate-actions")).toBeTruthy();
    fireEvent.click(screen.getByTestId("or-rev-tab-0"));
    expect(screen.queryByTestId("or-artifact-gate-actions")).toBeNull();
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes("/runs/run-1/gates"))).toBe(false);
  });

  it("renders configured plan scope and risks", async () => {
    const plan: ArtifactDetail = {
      ...ARTIFACT_FIXTURE,
      component_id: "dev-plan-viewer",
      revisions: [{
        ...ARTIFACT_FIXTURE.revisions[0]!,
        body: {
          summary: "One cohort.",
          cohorts: [{
            id: "core", repository_key: "oakridge", title: "Core", scope: "", depends_on: [],
            description: null, files_in_scope: [], decisions: [], acceptance_criteria: [],
          }],
          dependency_order: ["core"],
          scope: { in_scope: ["core"], out_of_scope: [] },
          acceptance_criteria: [],
          risks: ["migration"],
        },
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
    wrap(<ArtifactReview artifactId="art-1" />, plan);

    expect(await screen.findByText("Scope")).toBeTruthy();
    expect(screen.getByText("migration")).toBeTruthy();
    expect(screen.queryByTestId("or-plan-cohorts")).toBeNull();
  });

  it("shows error state when artifact fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "not found" }, 404));
    wrap(<ArtifactReview artifactId="bad-id" />, null);
    expect(await screen.findByTestId("or-artifact-detail-error")).toBeTruthy();
  });
});

describe("navigation inside the review", () => {
  // The pane frame above this body owns close and open-in-other-pane, and the
  // standalone artifact route is gone. A back control appearing here again
  // would sit directly under those and mean something different from them.
  it("offers none of its own, so the pane frame stays the only frame", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(ARTIFACT_FIXTURE));
    wrap(<ArtifactReview artifactId="art-1" />);

    await screen.findByTestId("or-artifact-type");
    expect(screen.queryByText("← Back")).toBeNull();
  });
});

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
    renderHandoff(null);
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/no open assessment review/)).toBeTruthy();
  });

  it("blocks send when the run has moved on", () => {
    renderHandoff({ ...HANDOFF_GATE, actionable: false });
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

  it("hides controls when assessment editing is unavailable or a historical revision is selected", async () => {
    const artifact: ArtifactDetail = {
      ...ARTIFACT_FIXTURE, component_id: "dev-assessment-viewer", type_id: "dev.assessment",
      producing_stage: "assessor", label: "alpha",
      capabilities: { reviewable: true, commentable: false, atom_editable: true, review_items: false },
      revisions: [
        { ...ARTIFACT_FIXTURE.revisions[0]!, body: HANDOFF_ASSESSMENT },
        { ...ARTIFACT_FIXTURE.revisions[0]!, id: "rev-2", body: HANDOFF_ASSESSMENT },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([]));
    const { unmount } = wrap(<ArtifactReview artifactId="art-1" />, artifact);
    expect(await screen.findByTestId("or-assessment-handoff")).toBeTruthy();
    fireEvent.click(screen.getByTestId("or-rev-tab-0"));
    expect(screen.queryByTestId("or-assessment-handoff")).toBeNull();
    unmount();
    wrap(<ArtifactReview artifactId="art-1" />, { ...artifact,
      capabilities: { ...artifact.capabilities!, atom_editable: false } });
    expect(screen.queryByTestId("or-assessment-handoff")).toBeNull();
    expect(screen.getByTestId("or-assessment-next-actions")).toBeTruthy();
  });
});
