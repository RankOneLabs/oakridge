import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RelationshipLinks } from "../components/molecules/RelationshipLinks";
import { StageOverviewContent } from "../components/organisms/StageOverview";
import type { StageEvaluation, StageExecution } from "../lib/stage-overview";
import { selectRevisionLink } from "../lib/recorded-relationships";
import type { OperatorArtifactRevisionView } from "../operator-contracts/projections/unit-view";
it("renders all three stage groups and explicit empty and unavailable reads", () => {
  const execution: StageExecution = { attempts: [], outputs: [], reviews: [], recorded_decisions: [] };
  const evaluation: StageEvaluation = { stages: { state: "unavailable" }, findings: { state: "loaded", value: [] }, tasks: { state: "pending" }, statuses: [], links: [] };
  render(<StageOverviewContent runId="run" label="Stage A" inputs={{ resolved_input: { input: "recorded" }, attempts: [], links: [] }} execution={execution} evaluation={evaluation} artifactState="loaded" onOpenBeside={() => {}} />);
  expect(["Inputs", "Execution and outputs", "Evaluation"].every((name) => screen.getByRole("region", { name }))).toBe(true);
  expect(screen.getByText("Grading stages: unavailable.")).toBeTruthy();
});
it("a resolved relationship click carries the pinned pane and an unresolved link cannot open", () => {
  const onOpen = vi.fn();
  const index = { run_id: "r", units: [], revisions: [{ id: "rev-1", run_id: "r", unit_id: "u", artifact_key: "a" } as OperatorArtifactRevisionView] };
  const links = [selectRevisionLink(index, { kind: "revision_predecessor", revision_id: "rev-1", label: "Earlier" }), selectRevisionLink(index, { kind: "revision_subject", revision_id: "missing", label: "Subject" })];
  render(<RelationshipLinks links={links} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: "Earlier · rev-1" }));
  expect(onOpen).toHaveBeenCalledWith({ kind: "artifact", artifact_id: "v2|artifact|r|u|a", revision_id: "rev-1", run_id: "r", unit_id: "u" });
  expect(screen.queryByRole("button", { name: /Subject/ })).toBeNull();
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { itemStatus, supportQuestion } from "../__fixtures__/grading";
import { sampleUnits } from "../__fixtures__/read-models";
import { selectStageInputs, selectStageExecution } from "../lib/stage-overview";
it("renders recorded input, attempts, sessions, outputs and grading questions from selector values", () => {
  const unit = sampleUnits.find((candidate) => candidate.attempts.length > 0 && candidate.artifacts.some((artifact) => artifact.latest_revision));
  if (!unit) throw new Error("captured fixture requires a published attempt");
  const revisions = unit.artifacts.flatMap((artifact) => artifact.latest_revision ? [artifact.latest_revision] : []);
  const source = { unit, index: { run_id: unit.run_id, units: sampleUnits, revisions }, artifacts: unit.artifacts.map((artifact) => ({ ...artifact, revisions: artifact.latest_revision ? [artifact.latest_revision] : [], status: "draft" as const, decisions: [], original_spec: null })) };
  const status = itemStatus([supportQuestion()]);
  const evaluation: StageEvaluation = { stages: { state: "loaded", value: [] }, findings: { state: "loaded", value: [] }, tasks: { state: "loaded", value: [] }, links: [], statuses: [{ state: "loaded", value: status }] };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StageOverviewContent runId={unit.run_id} label="Recorded stage" inputs={selectStageInputs(source)} execution={selectStageExecution(source)} evaluation={evaluation} artifactState="loaded" onOpenBeside={() => {}} /></QueryClientProvider>);
  expect(screen.getByRole("heading", { name: /succeeded.*initial.*current/ })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /Session/ }).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: `v${revisions[0]!.number} · ${revisions[0]!.id}` })).toBeTruthy();
  expect(screen.getByText(status.questions.items[0]!.question.question_text!)).toBeTruthy();
  expect(screen.getByText("Other answers and results are hidden.")).toBeTruthy();
});
