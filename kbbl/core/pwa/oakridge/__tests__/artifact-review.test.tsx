import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { makeArtifactRevision, makeBuildBriefFixture, makeDecision, makeArtifact, makeUnitView } from "../__fixtures__/read-models";
import { ArtifactReview } from "../components/organisms/ArtifactReview";

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** A unit whose `analysis` artifact has a plain text latest revision, which the generic viewer renders. */
function reviewUnit(revisionId = "revision-1") {
  const revision = makeArtifactRevision({ id: revisionId });
  return makeUnitView({ artifacts: [makeArtifact({ schema: "text", latest_revision: revision })] });
}
const isPublish = (input: RequestInfo | URL, init?: RequestInit): boolean => init?.method === "PUT" && String(input).includes("/artifacts/");

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("ArtifactReview", () => {
  it("renders the artifact key and the selected revision body", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    wrap(<ArtifactReview revisionId="revision-1" units={[reviewUnit()]} schemas={[]} onBack={() => undefined} onRefresh={() => undefined} />);

    expect(screen.getByTestId("or-artifact-review").textContent).toContain("analysis");
    expect(screen.getByTestId("or-revision-navigation").textContent).toContain("Revision 1");
    expect(screen.getByTestId("operator-typed-value").textContent).toContain("Spec body");
  });

  it("offers a decision only when its target is the selected revision", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const decision = makeDecision();
    const unit = makeUnitView({ ...reviewUnit(), decisions: [decision] });
    const { rerender } = wrap(<ArtifactReview revisionId="revision-1" units={[unit]} schemas={[]}
      onBack={() => undefined} onRefresh={() => undefined} />);
    expect(screen.getByTestId("or-gate-actions").textContent).toContain("Submit Approve");

    const otherUnit = makeUnitView({ ...reviewUnit("revision-2"), decisions: [decision] });
    rerender(<QueryClientProvider client={new QueryClient()}><ArtifactReview revisionId="revision-2"
      units={[otherUnit]} schemas={[]} onBack={() => undefined} onRefresh={() => undefined} /></QueryClientProvider>);
    expect(screen.queryByTestId("or-gate-actions")).toBeNull();
  });

  it("shows an unavailable state when the revision is no longer the latest", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    wrap(<ArtifactReview revisionId="missing" units={[reviewUnit()]} schemas={[]} onBack={() => undefined} onRefresh={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain("no longer among the unit's latest revisions");
  });

  it("uses the pane overview control for review navigation", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    wrap(<ArtifactReview revisionId="revision-1" units={[reviewUnit()]} schemas={[]} onBack={() => undefined} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "← Overview" })).toBeTruthy();
  });

  it("publishes an edited text as the revision after the one edited", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      isPublish(input, init) ? Response.json({ kind: "committed", run_id: "run-1", event_id: "event-1" }, { status: 201 }) : Response.json([]));
    vi.stubGlobal("fetch", fetch);
    const unit = reviewUnit();
    const refresh = vi.fn();
    wrap(<ArtifactReview revisionId="revision-1" units={[unit]} schemas={[]} onBack={() => undefined} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit artifact" }));
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Operator changed body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const request = fetch.mock.calls.find(([input, init]) => isPublish(input, init));
    expect([String(request?.[0]), JSON.parse(request?.[1]?.body as string)]).toEqual(["/oakridge/api/api/runs/run-1/units/unit-1/artifacts/analysis",
      { request_id: expect.any(String), body: "Operator changed body", predecessor: "revision-1", subject: null }]);
  });

  it("edits one field of a structured body and keeps the others", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      isPublish(input, init) ? Response.json({ kind: "committed", run_id: "run-1", event_id: "event-1" }, { status: 201 }) : Response.json([]));
    vi.stubGlobal("fetch", fetch);
    const brief = makeBuildBriefFixture();
    const revision = makeArtifactRevision({ artifact_key: "brief", body: brief.body });
    const unit = makeUnitView({ unit_key: "brief", artifacts: [makeArtifact({ artifact_key: "brief", schema: "brief_body", latest_revision: revision })] });
    const refresh = vi.fn();
    wrap(<ArtifactReview revisionId={revision.id} units={[unit]} schemas={[]} onBack={() => undefined} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit artifact" }));
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Updated brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const request = fetch.mock.calls.find(([input, init]) => isPublish(input, init));
    expect(JSON.parse(request?.[1]?.body as string).body).toEqual({ ...brief.body as object, title: "Updated brief" });
  });

  it("offers no edit for an artifact a code worker creates", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const revision = makeArtifactRevision();
    const unit = makeUnitView({ artifacts: [makeArtifact({ schema: "text", is_editable: false, latest_revision: revision })] });
    wrap(<ArtifactReview revisionId={revision.id} units={[unit]} schemas={[]} onBack={() => undefined} onRefresh={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Edit artifact" })).toBeNull();
  });

  it("opens the new revision when a saved edit replaces the selected revision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const predecessor = makeArtifactRevision();
    const revised = makeArtifactRevision({ id: "revision-2", predecessor_id: predecessor.id, number: 2 });
    const navigate = vi.fn();
    wrap(<ArtifactReview revisionId={predecessor.id} units={[makeUnitView({ artifacts: [makeArtifact({
      latest_revision: revised, revision_count: 2 })] })]} schemas={[]}
      onBack={() => undefined} onRefresh={() => undefined} onRevised={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(revised.id));
  });
});
