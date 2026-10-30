import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { ArtifactReview } from "../components/organisms/ArtifactReview";
import type { ArtifactDetail, ParkedGate } from "../types";
import type { Assessment } from "../lib/assessment";
import type { RunSessionAttempt } from "../types";
import type { Sid } from "../../lib/ids";
import type { SessionSnapshot } from "../../types";
import { useStore } from "../../state/store";
import { BuilderHandoffPanel } from "../components/organisms/BuilderHandoffPanel";

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

afterEach(() => vi.restoreAllMocks());

const HANDOFF_ASSESSMENT: Assessment = {
  head_sha: null, verdict: "pass_with_notes", findings: [], test_evidence: null,
  recommended_next_actions: ["Fix the first issue", "Add coverage"],
};
const BUILDER_ATTEMPT: RunSessionAttempt = {
  work_order_id: "work-builder", session_id: "builder-sid", stage_instance_id: "cohort-stage",
  stage_key: "builder", unit_id: "alpha", reason: "initial", work_order_state: "completed",
  created_at: "2026-10-01 00:00:00+00", completed_at: null, executor_health_kind: null,
  cleanup_state: "not_needed",
};

function renderHandoff(status: SessionSnapshot["status"] | null = "idle", attempts: RunSessionAttempt[] = [BUILDER_ATTEMPT], hasSessionInventory = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["oakridge", "run", "run-1", "sessions"], attempts);
  useStore.setState({
    sessions: status === null ? new Map() : new Map([["builder-sid" as Sid, { sid: "builder-sid", status } as SessionSnapshot]]),
    hasInboxSnapshot: hasSessionInventory,
    hasSessionSeed: hasSessionInventory,
  });
  const onEdit = vi.fn();
  const onSubmitBody = vi.fn();
  render(<QueryClientProvider client={client}><BuilderHandoffPanel assessment={HANDOFF_ASSESSMENT}
    body={HANDOFF_ASSESSMENT} runId="run-1" cohortLabel="alpha"
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
  it("unticks without publishing, then sends the exact preview once without a review decision", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ turn_key: "turn-1", status: "accepted" }));
    renderHandoff();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include action 2" }));
    const preview = screen.getByTestId("or-assessment-handoff-preview").textContent;
    expect(preview).toBe("Recommended next actions for the builder:\n\n1. Fix the first issue");
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    await screen.findByText("Sent");
    const calls = fetch.mock.calls.filter(([url]) => String(url).includes("/input"));
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toBe("/sessions/builder-sid/input");
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({ text: preview, client_message_id: expect.any(String) });
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/decide"))).toBe(false);
  });

  it("submits an anchor edit and a whole-body removal through distinct handles", () => {
    const { onEdit, onSubmitBody } = renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Edit recommended next actions/0" }));
    const input = screen.getByDisplayValue("Fix the first issue");
    expect(input.tagName).toBe("TEXTAREA");
    fireEvent.change(input, { target: { value: "Fix the revised issue" } });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenCalledWith("/recommended_next_actions/0", "Fix the first issue", "Fix the revised issue");
    fireEvent.click(screen.getByRole("button", { name: "Remove action 2" }));
    expect(onSubmitBody).toHaveBeenCalledWith(HANDOFF_ASSESSMENT,
      { ...HANDOFF_ASSESSMENT, recommended_next_actions: ["Fix the first issue"] });
  });

  it.each(["provisioning", "ended", "fenced", "failed"] as const)("blocks send for a %s builder session", (status) => {
    renderHandoff(status);
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(status === "provisioning" ? /still starting/ : /Use Resume/)).toBeTruthy();
  });

  it("explains a builder session missing from a completed inventory without claiming it ended", () => {
    renderHandoff(null);
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/missing from the session inventory.*use Resume if/)).toBeTruthy();
  });

  it("waits for the session inventory before diagnosing a missing builder session", () => {
    renderHandoff(null, [BUILDER_ATTEMPT], false);
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Waiting for the builder session inventory.")).toBeTruthy();
  });

  it("blocks send when there is no matching builder session", () => {
    renderHandoff("idle", [{ ...BUILDER_ATTEMPT, unit_id: "beta" }]);
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No builder session exists/)).toBeTruthy();
  });

  it("blocks send when every action is excluded", () => {
    renderHandoff();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include action 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include action 2" }));
    expect((screen.getByRole("button", { name: "Send to Builder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Include at least one next action/)).toBeTruthy();
  });

  it("keeps the same message id after a definitive rejection", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "session busy" }, 409))
      .mockResolvedValueOnce(json({ turn_key: "turn-1", status: "prompting" }));
    renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    await screen.findByText("session busy");
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    await screen.findByText("Sent");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).client_message_id)
      .toBe(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).client_message_id);
  });

  it("marks a thrown fetch as uncertain delivery", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection dropped"));
    renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    expect(await screen.findByText(/delivery status unknown; check the transcript before retrying/)).toBeTruthy();
  });

  it.each([
    { turn_key: "", status: "accepted", error: "invalid turn" },
    { turn_key: "turn-1", status: "queued", error: "not prompting" },
  ])("shows the server's error for an invalid send receipt", async (receipt) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(receipt));
    renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Send to Builder" }));
    expect(await screen.findByText(receipt.error)).toBeTruthy();
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
