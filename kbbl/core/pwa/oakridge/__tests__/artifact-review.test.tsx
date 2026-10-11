import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { makeArtifactRevision, makeBuildBriefFixture, makeCommand, makeDefinitionSummary, makeOutputSlot, makeScopeView } from "../__fixtures__/read-models";
import { ArtifactReview } from "../components/organisms/ArtifactReview";

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function reviewScope(revisionId = "revision-1") {
  const revision = makeArtifactRevision({ id: revisionId });
  return makeScopeView({ outputs: [makeOutputSlot({ current_revision_id: revision.id, current_revision: revision })] });
}
const scopeDefinitions = makeDefinitionSummary().source.scopes;

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("ArtifactReview", () => {
  it("renders the output key and the selected revision body", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    wrap(<ArtifactReview revisionId="revision-1" scopes={[reviewScope()]} schemas={[]} scopeDefinitions={scopeDefinitions}
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
    const { rerender } = wrap(<ArtifactReview revisionId="revision-1" scopes={[scope]} schemas={[]} scopeDefinitions={scopeDefinitions}
      onBack={() => undefined} onRefresh={() => undefined} />);
    expect(screen.getByTestId("or-gate-actions").textContent).toContain("Submit Approve");

    const otherScope = makeScopeView({ ...reviewScope("revision-2"), commands: [command],
      command_targets: { approve: [{ identity: "revision-1", version: 1 }] } });
    rerender(<QueryClientProvider client={new QueryClient()}><ArtifactReview revisionId="revision-2"
      scopes={[otherScope]} schemas={[]} scopeDefinitions={scopeDefinitions} onBack={() => undefined} onRefresh={() => undefined} /></QueryClientProvider>);
    expect(screen.queryByTestId("or-gate-actions")).toBeNull();
  });

  it("shows an unavailable state when the revision is absent from the scope projection", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    wrap(<ArtifactReview revisionId="missing" scopes={[reviewScope()]} schemas={[]} scopeDefinitions={scopeDefinitions}
      onBack={() => undefined} onRefresh={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain("unavailable in the current scope projection");
  });

  it("uses the pane overview control for review navigation", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    wrap(<ArtifactReview revisionId="revision-1" scopes={[reviewScope()]} schemas={[]} scopeDefinitions={scopeDefinitions}
      onBack={() => undefined} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "← Overview" })).toBeTruthy();
  });

  it("submits an edited text atom from the review surface", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).endsWith("/commands") ? Response.json({ kind: "accepted_pending", request_id: "request-1", transition_id: "transition-1", scope_version: 2 }, { status: 202 })
        : Response.json([]));
    vi.stubGlobal("fetch", fetch);
    const revision = makeArtifactRevision();
    const command = makeCommand({ key: "edit_analysis", label: "Edit analysis", targets: [] });
    const scope = makeScopeView({ scope_key: "spec_analysis", commands: [command], outputs: [makeOutputSlot({ current_revision: revision })],
      command_targets: { edit_analysis: [] } });
    const refresh = vi.fn();
    wrap(<ArtifactReview revisionId={revision.id} scopes={[scope]} schemas={[]} scopeDefinitions={scopeDefinitions}
      onBack={() => undefined} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit artifact" }));
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Operator changed body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const request = fetch.mock.calls.find(([input]) => String(input).endsWith("/commands"));
    expect(JSON.parse(request?.[1]?.body as string).payload).toMatchObject({ reviewed_revision_id: revision.id,
      prev_value: revision.body, body: { schema: "text", data: { kind: "string", value: "Operator changed body" } } });
  });

  it("uses the declared edit trigger and keeps the collection identity read-only", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).endsWith("/commands")
      ? Response.json({ kind: "accepted_pending", request_id: "request-1", transition_id: "transition-1", scope_version: 2 }, { status: 202 })
      : Response.json([]));
    vi.stubGlobal("fetch", fetch);
    const brief = makeBuildBriefFixture();
    const revision = makeArtifactRevision({ output_key: "briefs", collection_key: "brief-ui", body: brief.body });
    const command = makeCommand({ key: "revise_report", label: "Revise report", targets: [] });
    const scope = makeScopeView({ scope_key: "brief_writing", commands: [command],
      outputs: [makeOutputSlot({ output_key: "briefs", collection_key: "brief-ui", current_revision: revision })],
      command_targets: { revise_report: [] } });
    const customDefinitions = scopeDefinitions.map((definition) => definition.key === "brief_writing"
      ? { ...definition, outputs: definition.outputs.map((output) => output.key === "briefs"
        ? { ...output, edit_trigger: "revise_report" } : output) } : definition);
    const refresh = vi.fn();
    wrap(<ArtifactReview revisionId={revision.id} scopes={[scope]} schemas={brief.schemas}
      scopeDefinitions={customDefinitions} onBack={() => undefined} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit artifact" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("cohort_id").readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Updated brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const request = fetch.mock.calls.find(([input]) => String(input).endsWith("/commands"));
    expect(JSON.parse(request?.[1]?.body as string)).toMatchObject({ command_key: "revise_report",
      payload: { collection_key: "brief-ui" } });
  });

  it("opens the new revision when a saved edit replaces the selected revision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const predecessor = makeArtifactRevision();
    const revised = makeArtifactRevision({ id: "revision-2", predecessor_id: predecessor.id, version: 2 });
    const navigate = vi.fn();
    wrap(<ArtifactReview revisionId={predecessor.id} scopes={[makeScopeView({ outputs: [makeOutputSlot({
      current_revision_id: revised.id, current_revision: revised, version: 2 })] })]} schemas={[]} scopeDefinitions={scopeDefinitions}
      onBack={() => undefined} onRefresh={() => undefined} onRevised={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(revised.id));
  });
});
