import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { correctnessQuestion, id, IMPLEMENTATION, itemStatus, paged, reviewerAnswer, supportQuestion } from "../__fixtures__/grading";
import { compositeId } from "../adapters/core";
import { AssessmentViewer } from "../components/molecules/AssessmentViewer";
import { ItemGradeAction } from "../components/organisms/ItemGradeAction";
import { ShowAutomaticGrades } from "../components/organisms/ShowAutomaticGrades";
import type { ObservationItemAddress } from "../grading-contracts/grading/item-reads";
import type { ObservationItemStatusResponse } from "../grading-contracts/storage/grading-record-store";
import { parseAssessment } from "../lib/assessment";
import { useGradingVisibility } from "../state/gradingVisibility";

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
let status: ObservationItemStatusResponse;
beforeEach(() => {
  status = itemStatus([supportQuestion(), correctnessQuestion()]);
  useGradingVisibility.setState({ revealed_item_keys: new Set(), revealed_composite_run_ids: new Set() });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://kbbl.test").pathname;
    if (path === "/oakridge/observation/reviewer") return json({ reviewer_id: id("oakridge-operator") });
    if (path.endsWith("/items/at")) return json(status.item);
    if (path.endsWith("/status")) return json(status);
    return json({ error: { code: "unexpected", message: path } }, 404);
  }) as typeof fetch);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
const action = (selection: ObservationItemAddress = IMPLEMENTATION) => wrap(<ItemGradeAction runId="run-1" selection={selection} onOpenItem={vi.fn()} />);
const own = (question_id: string) => reviewerAnswer(`own-${question_id}`, "supports", "oakridge-operator", { question: { question_id: id(question_id), question_version: "1" } });

describe("the artifact's Grade button", () => {
  it("reads Grade while any question still waits on the operator", async () => {
    status = itemStatus([supportQuestion({ answers: paged([own("assessment_finding.evidence_support")]) }), correctnessQuestion()]);
    action();
    await screen.findByTestId("or-item-automatic-toggle");
    expect(screen.getByTestId("or-grade-item").textContent).toBe("Grade");
  });
  it("reads Graded once every question has the operator's answer", async () => {
    status = itemStatus([supportQuestion({ answers: paged([own("assessment_finding.evidence_support")]) }),
      correctnessQuestion({ answers: paged([own("assessment_finding.correctness")]) })]);
    action();
    await waitFor(() => expect(screen.getByTestId("or-grade-item").textContent).toBe("Graded"));
  });
});

describe("automatic grades on the artifact", () => {
  it("shows no automatic answer, label or glyph until revealed", async () => {
    action();
    await screen.findByTestId("or-item-automatic-toggle");
    expect(screen.queryByTestId("or-automatic-grades")).toBeNull();
    expect(document.body.innerHTML).not.toContain("does not support");
    expect(document.body.innerHTML).not.toContain("data-glyph");
  });
  it("reveals one item as glyphs only, with no rationale or evaluator detail", async () => {
    action();
    fireEvent.click(await screen.findByTestId("or-item-automatic-toggle"));
    const glyphs = await screen.findAllByTestId("or-automatic-grade");
    expect(glyphs.map((glyph) => [glyph.getAttribute("data-glyph"), glyph.getAttribute("aria-label")])).toEqual([
      ["negative", "Does the cited evidence support it?: does not support"], ["not_ready", "Is this finding correct?: Not ready"]]);
    expect(document.body.innerHTML).not.toContain("leak-marker");
    expect(document.body.innerHTML).not.toContain("jev-1.14.0");
    fireEvent.click(screen.getByTestId("or-item-automatic-toggle"));
    expect(screen.queryByTestId("or-automatic-grades")).toBeNull();
  });
  it("shows and hides every finding of the artifact together, each still hideable alone", async () => {
    const other = { ...IMPLEMENTATION, item_path: "/findings/0" };
    wrap(<><ShowAutomaticGrades selections={[IMPLEMENTATION, other]} />
      <ItemGradeAction runId="run-1" selection={IMPLEMENTATION} onOpenItem={vi.fn()} /><ItemGradeAction runId="run-1" selection={other} onOpenItem={vi.fn()} /></>);
    fireEvent.click(screen.getByTestId("or-show-automatic-grades"));
    await waitFor(() => expect(screen.getAllByTestId("or-automatic-grades")).toHaveLength(2));
    expect(screen.getByTestId("or-show-automatic-grades").textContent).toBe("Hide automatic grades");
    fireEvent.click(screen.getAllByTestId("or-item-automatic-toggle")[0]!);
    expect(screen.getAllByTestId("or-automatic-grades")).toHaveLength(1);
    expect(screen.getByTestId("or-show-automatic-grades").textContent).toBe("Show automatic grades");
    fireEvent.click(screen.getByTestId("or-show-automatic-grades"));
    fireEvent.click(screen.getByTestId("or-show-automatic-grades"));
    expect(screen.queryByTestId("or-automatic-grades")).toBeNull();
  });
  it("the assessment viewer renders the slots for its findings and a show-all control", () => {
    const parsed = parseAssessment({ head_sha: "abc", verdict: "fail", test_evidence: null, recommended_next_actions: [], findings: [
      { task_ids: [], status: "not_met", evidence: [], description: "one" }, { task_ids: [], status: "not_met", evidence: [], description: "two" }] });
    if (!parsed.ok) throw new Error(parsed.error.detail);
    const missing = { kind: "missing", cohort_label: null } as const;
    const revision_id = compositeId({ kind: "artifact", runId: "run-1", unitId: "u", name: `assessment:${IMPLEMENTATION.source_revision_id}` });
    const shown: ObservationItemAddress[][] = [];
    wrap(<AssessmentViewer assessment={parsed.value} brief={missing} result={missing} cohortLabel={null} source={{ revision_id }} onOpenItem={vi.fn()}
      itemGrading={{ renderItemAction: (selection) => <span data-testid="slot-action">{selection.item_path}</span>, renderShowAll: (selections) => { shown.push([...selections]); return <span data-testid="slot-all" />; } }} />);
    expect(screen.getAllByTestId("slot-action").map((slot) => slot.textContent).sort()).toEqual(["/findings/0", "/findings/1"]);
    expect(screen.getByTestId("slot-all")).toBeTruthy();
    expect(shown.at(-1)?.map((selection) => selection.item_path)).toEqual(["/findings/0", "/findings/1"]);
  });
});
