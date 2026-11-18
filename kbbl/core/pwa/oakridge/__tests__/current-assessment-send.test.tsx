import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CurrentBuilderHandoffPanel } from "../components/organisms/BuilderHandoffPanel";
import { CURRENT_ASSESSMENT } from "../__fixtures__/current-assessments";
import { currentAdjudicationUnit } from "../__fixtures__/read-models";
import type { OperatorAdjudication } from "../operator-contracts/domain/adjudication";
import { reviewToGates } from "../adapters/gates";
import { artifactRevisionId } from "../adapters/core";
import { invalidateCachedRunUnits } from "../client-units";
interface DecisionPost { readonly decision: string; readonly target: string; readonly payload: OperatorAdjudication }
afterEach(() => { cleanup(); vi.restoreAllMocks(); invalidateCachedRunUnits(null); });
it("the real mutation sends the preview and adjudication while preserving the core's redirected target", async () => {
  const unit = currentAdjudicationUnit();
  const unit_id = unit.unit_id;
  const artifact = unit.artifacts[0];
  const revision = artifact.latest_revision;
  if (!revision) throw new Error("assessment revision missing");
  const gates = reviewToGates(unit);
  if (!gates.ok || !gates.value[0]) throw new Error("gate missing");
  const gate = gates.value[0];
  expect(gate.requires_adjudication).toBe(true);
  const posts: DecisionPost[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") { posts.push(JSON.parse(String(init.body)) as DecisionPost); return Response.json({ kind: "committed", run_id: "run", event_id: "decision:1" }); }
    if (url.endsWith(`/units/${encodeURIComponent(unit_id)}`)) return Response.json(unit);
    throw new Error(`unexpected request: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><CurrentBuilderHandoffPanel assessment={CURRENT_ASSESSMENT} revisionId={artifactRevisionId(artifact, revision.id)} gate={gate} decisions={[]} /></QueryClientProvider>);
  const builder = screen.getByRole("region", { name: "builder actions" });
  fireEvent.click(within(builder).getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText(`Replacement for ${CURRENT_ASSESSMENT.next_actions[0].id}`), { target: { value: "Investigate and add regression coverage." } });
  fireEvent.click(within(screen.getByRole("region", { name: "operator actions" })).getByRole("button", { name: "Accept" }));
  const preview = screen.getByTestId("or-assessment-handoff-preview").textContent;
  fireEvent.click(screen.getByRole("button", { name: "Request build changes" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ decision: "request_build_changes", target: "build:1", payload: { builder_feedback: preview,
    entries: [{ original_text: CURRENT_ASSESSMENT.next_actions[0].text, final_text: "Investigate and add regression coverage.", disposition: "modified" }, { disposition: "accepted", audience: "operator" }] } });
  client.clear();
});
