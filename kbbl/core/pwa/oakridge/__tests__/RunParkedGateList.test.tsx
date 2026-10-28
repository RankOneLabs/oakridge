import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import sample from "../__fixtures__/v2-adapter-sample.json";
import { withUnitFields } from "../__fixtures__/read-models";
import { invalidateCachedRunUnits } from "../client";
import { RunParkedGateList } from "../components/organisms/ParkedGateList";
import type { OperatorUnitView } from "../operator-contracts";

const units = sample.units as unknown as OperatorUnitView[];
const runId = units[0].run_id;
const cohort = units.find((unit) => unit.stage === "cohort" && unit.artifacts.some((artifact) => artifact.artifact_key === "assessment" && artifact.latest_revision));
const assessment = cohort?.artifacts.find((artifact) => artifact.artifact_key === "assessment")?.latest_revision;
if (!cohort || !assessment) throw new Error("captured fixture lacks a cohort with an assessment");

afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(runId); });

it("keeps feedback the operator sent on the run after the page is left and reopened", async () => {
  const decided = withUnitFields(cohort, { decisions: [], recorded_decisions: [{ id: "d1", review: "assessment_review", decision: "request_assessment_changes",
    effect: "request_changes", target_revision_id: assessment.id, payload: { feedback: "Check the migration path." }, created_at: "2026-10-28T12:00:00Z" }] });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(units.map((unit) => unit.unit_id === cohort.unit_id ? decided : unit)),
    { status: 200, headers: { "Content-Type": "application/json" } }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RunParkedGateList runId={runId} /></QueryClientProvider>);
  expect((await screen.findByTestId("or-sent-feedback-text")).textContent).toBe("Check the migration path.");
});
