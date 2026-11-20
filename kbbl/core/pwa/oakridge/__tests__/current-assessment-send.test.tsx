import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdjudicationHarness } from "./assessment-adjudication-harness";
import { CURRENT_ASSESSMENT } from "../__fixtures__/current-assessments";
import { currentAdjudicationUnit } from "../__fixtures__/read-models";
import type { OperatorAdjudication } from "../operator-contracts/domain/adjudication";
import { reviewToGates } from "../adapters/gates";
import { artifactRevisionId } from "../adapters/core";
import { invalidateCachedRunUnits } from "../client-units";
interface DecisionPost { readonly decision: string; readonly target: string; readonly expected_assessment_revision_id: string; readonly payload: OperatorAdjudication }
afterEach(() => { cleanup(); vi.restoreAllMocks(); invalidateCachedRunUnits(null); });
it.each([
  { review: "assessment_review", stage: "cohort", decision: "request_build_changes", target: "build:1", button: "Send to builder" },
  { review: "integration_review", stage: "integration", decision: "request_changes", target: "assessment:1", button: "Send to integrator" },
  { review: "expansion_review", stage: "expansion", decision: "send_to_expander", target: "expansion:1", button: "Send to builder" },
])("the real $review mutation posts the preview and adjudication to the core target", async ({ review, stage, decision, target, button }) => {
  const cohort = currentAdjudicationUnit();
  const unit = { ...cohort, stage, decisions: cohort.decisions.map(definition => {
    if (definition.submit.kind !== "review") return definition;
    const key = definition.key === "accept" ? "accept" : decision;
    return { ...definition, key, label: key === "accept" ? "Accept" : button, submit: { ...definition.submit, review, decision: key,
      target_revision_id: key === "accept" ? "assessment:1" : target } };
  }) };
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
    if (init?.method === "POST") { expect(url).toContain(`/reviews/${review}/decide`); posts.push(JSON.parse(String(init.body)) as DecisionPost); return Response.json({ kind: "committed", run_id: "run", event_id: "decision:1" }); }
    if (url.endsWith(`/units/${encodeURIComponent(unit_id)}`)) return Response.json(unit);
    throw new Error(`unexpected request: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AdjudicationHarness assessment={CURRENT_ASSESSMENT} revisionId={artifactRevisionId(artifact, revision.id)} gate={gate} decisions={[]} /></QueryClientProvider>);
  const builder = within(screen.getByRole("region", { name: "builder actions" }));
  fireEvent.click(builder.getByRole("button", { name: "Edit" }));
  fireEvent.change(builder.getByLabelText("Replacement text"), { target: { value: "Investigate and add regression coverage." } });
  const preview = screen.getByTestId("or-assessment-handoff-preview").textContent;
  fireEvent.click(within(screen.getByRole("region", { name: "Assessment decision" })).getByRole("button", { name: `${button} (1)` }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ decision, target, expected_assessment_revision_id: "assessment:1", payload: { builder_feedback: preview,
    entries: [{ original_text: CURRENT_ASSESSMENT.next_actions[0].text, final_text: "Investigate and add regression coverage.", disposition: "modified" }, { disposition: "accepted", audience: "operator" }] } });
  client.clear();
});

it("study's expansion review posts a plain request for assessment changes", async () => {
  const cohort = currentAdjudicationUnit();
  const assessmentChanges = { key: "request_assessment_changes", label: "Request assessment changes", payload_schema: "{feedback: text}",
    fields: [{ key: "feedback", label: "What must the assessment change?" }],
    submit: { kind: "review" as const, review: "expansion_review", decision: "request_assessment_changes", effect: "request_changes" as const, target_revision_id: "assessment:1" } };
  const unit = { ...cohort, stage: "expansion", decisions: [...cohort.decisions.map(definition => {
    if (definition.submit.kind !== "review") return definition;
    const key = definition.key === "accept" ? "accept" : "send_to_expander";
    return { ...definition, key, label: key === "accept" ? "Accept" : "Send to builder", submit: { ...definition.submit, review: "expansion_review", decision: key } };
  }), assessmentChanges] };
  const artifact = unit.artifacts[0];
  const revision = artifact.latest_revision;
  if (!revision) throw new Error("assessment revision missing");
  const gates = reviewToGates(unit);
  if (!gates.ok || !gates.value[0]) throw new Error("gate missing");
  expect(gates.value[0].resume_actions).not.toContain("send_to_expander");
  const posts: { readonly decision: string; readonly target: string; readonly payload: { readonly feedback: string } }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") { expect(url).toContain("/reviews/expansion_review/decide"); posts.push(JSON.parse(String(init.body)) as typeof posts[number]); return Response.json({ kind: "committed", run_id: "run", event_id: "decision:1" }); }
    if (url.endsWith(`/units/${encodeURIComponent(unit.unit_id)}`)) return Response.json(unit);
    throw new Error(`unexpected request: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AdjudicationHarness assessment={CURRENT_ASSESSMENT} revisionId={artifactRevisionId(artifact, revision.id)} gate={gates.value[0]} decisions={[]} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Request assessment changes…" }));
  fireEvent.change(screen.getByLabelText("Assessment feedback"), { target: { value: "Cite the failing case." } });
  fireEvent.click(screen.getByRole("button", { name: "Request assessment changes" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ decision: "request_assessment_changes", target: "assessment:1", payload: { feedback: "Cite the failing case." } });
  client.clear();
});
