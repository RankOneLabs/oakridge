import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import currentBrief from "../__fixtures__/current-brief.json";
import { ArtifactReview } from "../components/organisms/ArtifactReview";
import type { ArtifactDetail, ArtifactRevision, ParkedGate } from "../artifact-types";
import { invalidateCachedRunUnits } from "../client";
import { CURRENT_ASSESSMENT } from "../__fixtures__/current-assessments";

vi.mock("../hooks/useCohortArtifact", () => ({ useCohortArtifact: () => ({ kind: "missing" }) }));
vi.mock("../hooks/useAssessmentHistory", () => ({ useAssessmentHistory: () => ({ data: [], isError: false, error: null }) }));

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

const REVISION_FIXTURE: ArtifactRevision = {
  id: "rev-1",
  status: "approved",
  created_at: "2026-07-01T09:00:00Z",
  body: { title: "Spec body" },
  validation: { valid: true },
};

const ARTIFACT_FIXTURE: ArtifactDetail = {
  id: "art-1",
  type_id: "spec_v2",
  component_id: null,
  capabilities: null,
  anchor_schema: null,
  run_id: "run-1",
  producing_stage: "spec",
  revisions: [REVISION_FIXTURE],
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
        ...REVISION_FIXTURE,
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
        REVISION_FIXTURE,
        { ...REVISION_FIXTURE, id: "rev-2", status: "draft" },
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

  it.each([false, true])("shows a second decision box only for a declared plain action (plain action offered: %s)", async hasPlain => {
    const assessment: ArtifactDetail = { ...ARTIFACT_FIXTURE, type_id: "dev.assessment", component_id: "dev-current-assessment-viewer",
      revisions: [{ ...REVISION_FIXTURE, status: "draft", body: CURRENT_ASSESSMENT }] };
    const gate: ParkedGate = { ...PARKED_GATE_FIXTURE, run_id: "run-1", gate_step: "assessment_review", artifact_revision_id: "rev-1", assessment_revision_id: "rev-1", requires_adjudication: true,
      resume_actions: hasPlain ? ["request_assessment_changes"] : [], offered_decisions: hasPlain ? ["accept", "request_assessment_changes"] : ["accept"], decision_definitions: [{ key: "accept", label: "Accept", payload_schema: "adjudication", adjudication: "accept", assessment: "assessment", fields: [],
        submit: { kind: "review", review: "assessment_review", decision: "accept", effect: "approve", target_revision_id: "rev-1" } }, ...(hasPlain ? [{ key: "request_assessment_changes", label: "Request assessment changes", adjudication: null, assessment: "assessment", fields: [], payload_schema: "{}",
          submit: { kind: "review" as const, review: "assessment_review", decision: "request_assessment_changes", effect: "request_changes" as const, target_revision_id: "rev-1" } }] : [])] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).includes("/gates") ? json([gate]) : json(assessment));
    wrap(<ArtifactReview artifactId="art-1" />, assessment, [gate]);

    expect(await screen.findByRole("region", { name: "Assessment decision" })).toBeTruthy();
    expect(Boolean(screen.queryByTestId("or-artifact-gate-actions"))).toBe(hasPlain);
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

describe("artifact presentation", () => {
  it("defaults to rendered and uses the same pinned revision in the structured tree and raw formats", async () => {
    const artifact: ArtifactDetail = { ...ARTIFACT_FIXTURE, component_id: "dev-pr-summary-viewer",
      revisions: [{ ...REVISION_FIXTURE, body: { summary: "Earlier content" } },
        { ...REVISION_FIXTURE, id: "rev-2", body: { summary: "Latest content" } }] };
    wrap(<ArtifactReview artifactId="art-1" revisionId="rev-1" />, artifact);
    expect(screen.getByRole("tab", { name: "rendered" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "structured" }));
    expect(screen.getByTestId("or-revision-panel").getAttribute("data-revision-id")).toBe("rev-1");
    expect(screen.getByTestId("or-revision-body").textContent).toContain("Earlier content");
    expect(screen.getByTestId("or-revision-yaml").textContent).toContain("Earlier content");
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
  });
  it("reports an unavailable pinned revision instead of falling forward to latest", () => {
    wrap(<ArtifactReview artifactId="art-1" revisionId="absent" />);
    expect(screen.getByText("Recorded revision absent is unavailable.")).toBeTruthy();
  });
});

import { compositeId } from "../adapters/core";
import { itemStatus, supportQuestion } from "../__fixtures__/grading";
import { useGradingVisibility } from "../state/gradingVisibility";

it("keeps grade controls and blind state across presentation switches", async () => {
  useGradingVisibility.setState({ revealed_item_keys: new Set() });
  const revisionId = compositeId({ kind: "artifact", runId: "run-1", unitId: "u", name: "brief:raw-revision" });
  const artifact: ArtifactDetail = { ...ARTIFACT_FIXTURE, component_id: "dev-current-brief-viewer", capabilities: { atom_editable: true, commentable: false, reviewable: false, review_items: false },
    revisions: [{ ...REVISION_FIXTURE, id: revisionId, body: currentBrief }] };
  const status = itemStatus([supportQuestion()]);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.includes("/items/at")) return json(status.item);
    if (path.includes("/status")) return json(status);
    if (path.includes("/reviewer")) return json({ reviewer_id: "operator" });
    return json({});
  });
  wrap(<ArtifactReview artifactId="art-1" onOpenItem={() => {}} />, artifact);
  fireEvent.click(screen.getByRole("tab", { name: "structured" }));
  expect(screen.getByRole("button", { name: "Open grading at /build_items/0" })).toBeTruthy();
  expect(screen.queryAllByTestId("or-automatic-grades")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Show automatic grades" }));
  await waitFor(() => expect(useGradingVisibility.getState().revealed_item_keys.size).toBe(currentBrief.build_items.length));
  fireEvent.click(screen.getByRole("tab", { name: "rendered" }));
  expect(screen.getByRole("button", { name: "Hide automatic grades" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide automatic grades" }));
  fireEvent.click(screen.getByRole("tab", { name: "structured" }));
  expect(screen.queryAllByTestId("or-automatic-grades")).toHaveLength(0);
});
