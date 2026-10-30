// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BuildBriefViewer } from "./BuildBriefViewer";
import legacyBrief from "../../lib/__fixtures__/legacy-brief.json";
import linkedBrief from "../../lib/__fixtures__/id-linked-brief.json";
import type { StageUnit } from "../../types";
import { CohortBrief } from "./CohortBrief";

const saved = () => vi.fn().mockResolvedValue({ ok: true, value: undefined });

const body = {
  cohort_id: "brief-ui",
  repository_key: "oakridge",
  title: "Build brief review UI",
  depends_on: [],
  goal: "Make the brief reviewable.",
  files_in_scope: ["kbbl/core/pwa/oakridge"],
  decisions_made: [{ decision: "Reuse v1", rationale: "It is proven." }],
  approaches_rejected: [],
  acceptance_criteria: ["Operator can approve the artifact."],
  next_action: "Open the brief artifact.",
};

afterEach(cleanup);

describe("BuildBriefViewer", () => {
  test("marks a legacy revision and retains its decisions, rejected approaches and criteria", () => {
    render(<BuildBriefViewer body={legacyBrief} />);
    expect(screen.getByText("Not id-linked")).toBeTruthy();
    expect(screen.getByText("Keep the existing layout.")).toBeTruthy();
    expect(screen.getByText("Replace the layout.")).toBeTruthy();
    expect(screen.getByText("The plan is readable.")).toBeTruthy();
  });

  test("shows ids and criterion and rejection links on a linked revision", () => {
    render(<BuildBriefViewer body={linkedBrief} />);
    expect(screen.queryByText("Not id-linked")).toBeNull();
    expect(screen.getByText("decision-new")).toBeTruthy();
    expect(screen.getByText("approach-replace")).toBeTruthy();
    expect(screen.getByText("task-plan")).toBeTruthy();
    expect(screen.getByText("The brief remains readable.")).toBeTruthy();
  });

  test("keeps legacy JSON pointer anchors for decision, rejection and criterion edits", async () => {
    const onEdit = saved();
    render(<BuildBriefViewer body={legacyBrief} edit={{ enabled: true, isPending: false, onEdit }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit brief" }));
    for (const [name, newValue] of [
      ["decisions made/0/decision", "Keep this layout."],
      ["approaches rejected/0/reason", "Too disruptive."],
      ["acceptance criteria/0", "The plan stays readable."],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }));
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: newValue } });
      fireEvent.blur(input);
      await screen.findByRole("button", { name: `Edit ${name}` });
    }
    expect(onEdit.mock.calls.map((call) => call[0])).toEqual(["/decisions_made/0/decision", "/approaches_rejected/0/reason", "/acceptance_criteria/0"]);
  });

  test("reads as text until the operator turns on editing", () => {
    render(<BuildBriefViewer body={body} edit={{ enabled: true, isPending: false, onEdit: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Edit goal" })).toBeNull();
  });

  test("offers no edit toggle on a revision that cannot be edited", () => {
    render(<BuildBriefViewer body={body} edit={{ enabled: false, isPending: false, onEdit: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Edit brief" })).toBeNull();
  });

  test("offers registered atom editing and submits an RFC-6901 anchor", () => {
    const onEdit = saved();
    render(<BuildBriefViewer body={body} edit={{ enabled: true, isPending: false, onEdit }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit brief" }));

    fireEvent.click(screen.getByText("Make the brief reviewable."));
    const input = screen.getByDisplayValue("Make the brief reviewable.");
    fireEvent.change(input, { target: { value: "Make every brief reviewable." } });
    fireEvent.blur(input);

    expect(onEdit).toHaveBeenCalledWith(
      "/goal",
      "Make the brief reviewable.",
      "Make every brief reviewable.",
    );
  });

  test("edits nested array and object atoms", async () => {
    const onEdit = saved();
    render(<BuildBriefViewer body={body} edit={{ enabled: true, isPending: false, onEdit }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit brief" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit files in scope/0" }));
    const fileInput = screen.getByDisplayValue("kbbl/core/pwa/oakridge");
    fireEvent.change(fileInput, { target: { value: "kbbl/core/pwa/oakridge/viewers" } });
    fireEvent.blur(fileInput);
    await screen.findByRole("button", { name: "Edit files in scope/0" });

    fireEvent.click(screen.getByRole("button", { name: "Edit decisions made/0/rationale" }));
    const rationaleInput = screen.getByDisplayValue("It is proven.");
    fireEvent.change(rationaleInput, { target: { value: "It preserves proven behavior." } });
    fireEvent.blur(rationaleInput);

    expect(onEdit).toHaveBeenNthCalledWith(1, "/files_in_scope/0", "kbbl/core/pwa/oakridge", "kbbl/core/pwa/oakridge/viewers");
    expect(onEdit).toHaveBeenNthCalledWith(2, "/decisions_made/0/rationale", "It is proven.", "It preserves proven behavior.");
  });
});

function briefUnit(artifact: unknown): StageUnit {
  return { unit_id: "pwa", repository_key: null, params: { artifact }, sid: null, worktree: null, status: "complete", gate: null, is_retryable: false };
}

describe("CohortBrief", () => {
  test("marks a legacy brief and keeps its decision and criterion text", () => {
    render(<CohortBrief unit={briefUnit(legacyBrief)} />);
    expect(screen.getByText("Not id-linked")).toBeTruthy();
    expect(screen.getByText("Keep the existing layout.")).toBeTruthy();
    expect(screen.getByText("The plan is readable.")).toBeTruthy();
  });

  test("shows linked decision, criterion, task and rejected approach ids", () => {
    render(<CohortBrief unit={briefUnit(linkedBrief)} />);
    expect(screen.queryByText("Not id-linked")).toBeNull();
    expect(screen.getByText("decision-new")).toBeTruthy();
    expect(screen.getByText("criterion-plan")).toBeTruthy();
    expect(screen.getByText("task-plan")).toBeTruthy();
    expect(screen.getByText("approach-replace")).toBeTruthy();
  });
});
