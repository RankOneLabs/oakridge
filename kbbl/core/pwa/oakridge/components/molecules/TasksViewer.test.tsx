// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveViewer } from "../../artifactRegistry";
import { isSpecAnalysis } from "../../lib/spec-analysis";
import { SpecAnalysisViewer } from "./SpecAnalysisViewer";
import { TasksViewer } from "./TasksViewer";

const body = { tasks: [
  { id: "task-a", description: "Build the viewer.", requirement_ids: ["req-a"] },
  { id: "task-b", description: "Write docs for req-a.", requirement_ids: [] },
] };

afterEach(cleanup);

describe("TasksViewer", () => {
  test("is registered for tasks artifacts", () => {
    expect(resolveViewer("dev-tasks-viewer")).toBe(TasksViewer);
  });

  test("renders each task and keeps an empty requirement list unlinked", () => {
    render(<TasksViewer body={body} />);
    expect(screen.getByText("task-a")).toBeTruthy();
    expect(screen.getByText("Build the viewer.")).toBeTruthy();
    expect(screen.getByText("req-a")).toBeTruthy();
    expect(screen.getByText("task-b")).toBeTruthy();
    expect(screen.getByText("Unlinked")).toBeTruthy();
    expect(screen.getAllByTestId("or-task-requirements")[1]?.textContent).not.toContain("req-a");
  });

  test("hides the edit toggle when editing is disabled", () => {
    render(<TasksViewer body={body} edit={{ enabled: false, isPending: false, onEdit: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Edit tasks" })).toBeNull();
  });

  test("edits a task atom through its JSON pointer", () => {
    const onEdit = vi.fn();
    render(<TasksViewer body={body} edit={{ enabled: true, isPending: false, onEdit }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit tasks/0/description" }));
    const input = screen.getByDisplayValue("Build the viewer.");
    fireEvent.change(input, { target: { value: "Build the tasks viewer." } });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenCalledWith("/tasks/0/description", "Build the viewer.", "Build the tasks viewer.");
  });

  test("adds a requirement link to an unlinked task", () => {
    const onEdit = vi.fn();
    render(<TasksViewer body={body} edit={{ enabled: true, isPending: false, onEdit }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit tasks" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Add link" })[1]!);
    fireEvent.change(screen.getByRole("textbox", { name: "New requirement ID" }), { target: { value: "req-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save link" }));
    expect(onEdit).toHaveBeenCalledWith("/tasks/1/requirement_ids", [], ["req-b"]);
  });

  test("shows a pending save while editing", () => {
    render(<TasksViewer body={body} edit={{ enabled: true, isPending: true, onEdit: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit tasks" }));
    expect(screen.getByText("Saving…")).toBeTruthy();
  });
});

const analysis = {
  summary: "Analysis summary.", source_spec_refs: [],
  findings: [{ id: "finding-a", description: "A missing contract.", severity: "warning" }],
  requirements: [], risks: [],
  proposed_spec_updates: [
    { section: "API", change: "Add the contract.", reason: "Avoid ambiguity.", finding_ids: ["finding-a", "missing-finding"] },
    { section: "Docs", change: "Clarify wording.", reason: "For readers.", finding_ids: [] },
  ],
};

describe("SpecAnalysisViewer finding links", () => {
  test("resolves present findings and keeps missing ids visible", () => {
    expect(isSpecAnalysis(analysis)).toBe(true);
    render(<SpecAnalysisViewer body={analysis} />);
    const links = screen.getAllByTestId("or-spec-update-findings");
    expect(links[0]?.textContent).toContain("A missing contract.");
    expect(links[0]?.textContent).toContain("missing-finding");
    expect(links[1]?.textContent).toContain("Unlinked");
    expect(screen.getByText("Why: Avoid ambiguity.")).toBeTruthy();
  });

  test("accepts and displays a legacy update without finding_ids", () => {
    const legacy = { ...analysis, proposed_spec_updates: [{ section: "API", change: "Add the contract.", reason: "Avoid ambiguity." }] };
    expect(isSpecAnalysis(legacy)).toBe(true);
    render(<SpecAnalysisViewer body={legacy} />);
    expect(screen.getByTestId("or-spec-update-findings").textContent).toContain("Unlinked");
  });
});
