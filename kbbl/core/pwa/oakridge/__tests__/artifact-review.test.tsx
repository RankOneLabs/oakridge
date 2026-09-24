import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { ArtifactReview } from "../components/organisms/ArtifactReview";
import type { ArtifactDetail, ParkedGate } from "../types";

// Split out of oakridge.test.tsx when the chrome union landed: the review
// organism now has two hosts, and its cases outgrew the shared file.

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

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

const ROUTE_CHROME = { kind: "route", onBack: () => {} } as const;
const PANE_CHROME = { kind: "pane" } as const;

describe("ArtifactReview", () => {
  it("renders artifact type, producing stage, and revision body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(ARTIFACT_FIXTURE));
    wrap(<ArtifactReview artifactId="art-1" chrome={ROUTE_CHROME} />);

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
    wrap(<ArtifactReview artifactId="art-1" chrome={ROUTE_CHROME} />);
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
    wrap(<ArtifactReview artifactId="art-1" chrome={ROUTE_CHROME} />);

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
    wrap(<ArtifactReview artifactId="art-1" chrome={ROUTE_CHROME} />);

    await screen.findByTestId("or-artifact-type");
    expect(await screen.findByTestId("or-artifact-gate-actions")).toBeTruthy();
    fireEvent.click(screen.getByTestId("or-rev-tab-0"));
    expect(screen.queryByTestId("or-artifact-gate-actions")).toBeNull();
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes("/runs/run-1/gates"))).toBe(true);
  });

  it("renders configured plan scope and risks", async () => {
    const plan: ArtifactDetail = {
      ...ARTIFACT_FIXTURE,
      component_id: "dev-plan-viewer",
      revisions: [{
        ...ARTIFACT_FIXTURE.revisions[0]!,
        body: { scope: { include: ["core"] }, risks: ["migration"] },
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
    wrap(<ArtifactReview artifactId="art-1" chrome={ROUTE_CHROME} />);

    expect(await screen.findByText("Scope")).toBeTruthy();
    expect(screen.getByText("Risks")).toBeTruthy();
    expect(screen.getByText("migration")).toBeTruthy();
  });

  it("shows error state when artifact fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "not found" }, 404));
    wrap(<ArtifactReview artifactId="bad-id" chrome={ROUTE_CHROME} />);
    expect(await screen.findByTestId("or-artifact-detail-error")).toBeTruthy();
  });
});

describe("the chrome variant", () => {
  it("offers a back button to a route host", async () => {
    const onBack = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(ARTIFACT_FIXTURE));
    wrap(<ArtifactReview artifactId="art-1" chrome={{ kind: "route", onBack }} />);

    await screen.findByTestId("or-artifact-type");
    fireEvent.click(screen.getByText("← Back"));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("offers no back button to a pane host", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(ARTIFACT_FIXTURE));
    wrap(<ArtifactReview artifactId="art-1" chrome={PANE_CHROME} />);

    await screen.findByTestId("or-artifact-type");
    expect(screen.queryByText("← Back")).toBeNull();
  });

  it("offers no back button to a pane host while the artifact is still loading", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    wrap(<ArtifactReview artifactId="art-1" chrome={PANE_CHROME} />);

    expect(screen.getByText("Loading artifact…")).toBeTruthy();
    expect(screen.queryByText("← Back")).toBeNull();
  });

  it("offers no back button to a pane host when the artifact read fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "not found" }, 404));
    wrap(<ArtifactReview artifactId="bad-id" chrome={PANE_CHROME} />);

    expect(await screen.findByTestId("or-artifact-detail-error")).toBeTruthy();
    expect(screen.queryByText("← Back")).toBeNull();
  });
});
