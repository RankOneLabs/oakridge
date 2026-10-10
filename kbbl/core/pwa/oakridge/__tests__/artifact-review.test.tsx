import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { makeArtifactRevision, makeCommand, makeOutputSlot, makeScopeView } from "../__fixtures__/read-models";
import { ArtifactReview } from "../components/organisms/ArtifactReview";

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function reviewScope(revisionId = "revision-1") {
  const revision = makeArtifactRevision({ id: revisionId });
  return makeScopeView({ outputs: [makeOutputSlot({ current_revision_id: revision.id, current_revision: revision })] });
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("ArtifactReview", () => {
  it("renders the output key and the selected revision body", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    wrap(<ArtifactReview revisionId="revision-1" scopes={[reviewScope()]} schemas={[]}
      onBack={() => undefined} onRefresh={() => undefined} />);

    expect(screen.getByTestId("or-artifact-review").textContent).toContain("analysis");
    expect(screen.getByTestId("or-revision-navigation").textContent).toContain("Revision 1");
    expect(screen.getByTestId("operator-typed-value").textContent).toContain("Spec body");
  });

  it("offers a command only when its observed target is the selected revision", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const command = makeCommand();
    const scope = makeScopeView({ ...reviewScope(), commands: [command],
      command_targets: { approve: [{ identity: "revision-1", version: 1 }] } });
    const { rerender } = wrap(<ArtifactReview revisionId="revision-1" scopes={[scope]} schemas={[]}
      onBack={() => undefined} onRefresh={() => undefined} />);
    expect(screen.getByTestId("or-gate-actions").textContent).toContain("Submit Approve");

    const otherScope = makeScopeView({ ...reviewScope("revision-2"), commands: [command],
      command_targets: { approve: [{ identity: "revision-1", version: 1 }] } });
    rerender(<QueryClientProvider client={new QueryClient()}><ArtifactReview revisionId="revision-2"
      scopes={[otherScope]} schemas={[]} onBack={() => undefined} onRefresh={() => undefined} /></QueryClientProvider>);
    expect(screen.queryByTestId("or-gate-actions")).toBeNull();
  });

  it("shows an unavailable state when the revision is absent from the scope projection", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    wrap(<ArtifactReview revisionId="missing" scopes={[reviewScope()]} schemas={[]}
      onBack={() => undefined} onRefresh={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain("unavailable in the current scope projection");
  });

  it("uses the pane overview control for review navigation", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    wrap(<ArtifactReview revisionId="revision-1" scopes={[reviewScope()]} schemas={[]}
      onBack={() => undefined} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "← Overview" })).toBeTruthy();
  });
});
