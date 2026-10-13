import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { fetchOperatorDefinitionDetail, fetchOperatorDefinitions } from "../client";
import { makeDefinitionDetail, makeDefinitionSummary, makeWorkflowSource } from "../__fixtures__/read-models";
import { WorkflowDefListView } from "../views/WorkflowDefListView";
import { WorkflowDefDetailView } from "../views/WorkflowDefDetailView";
import { WorkflowDefEditorView } from "../views/WorkflowDefEditorView";

vi.mock("../client", () => ({ fetchOperatorDefinitions: vi.fn(), fetchOperatorDefinitionDetail: vi.fn(),
  compileOperatorDefinition: vi.fn(), pinOperatorDefinition: vi.fn(), setOperatorDefinitionArchived: vi.fn() }));

function show(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

const list = (onNew = vi.fn(), onSelect = vi.fn(), onClone = vi.fn()) =>
  show(<WorkflowDefListView onBack={() => undefined} onNew={onNew} onSelect={onSelect} onClone={onClone} />);
const editor = (cloneFromId: string | null = null) =>
  show(<WorkflowDefEditorView cloneFromId={cloneFromId} onBack={() => undefined} onCreated={() => undefined} />);

beforeEach(() => {
  vi.mocked(fetchOperatorDefinitions).mockResolvedValue([]);
  vi.mocked(fetchOperatorDefinitionDetail).mockResolvedValue(makeDefinitionDetail());
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("pinned definition catalog", () => {
  it("shows loading while definitions are pending", () => {
    vi.mocked(fetchOperatorDefinitions).mockImplementation(() => new Promise(() => undefined));
    list();
    expect(screen.getByRole("status").textContent).toContain("Loading definitions");
  });

  it("renders a row for each pinned definition", async () => {
    vi.mocked(fetchOperatorDefinitions).mockResolvedValue([
      makeDefinitionSummary(), makeDefinitionSummary({ bundle_id: "bundle-2", digest: "digest-2" }),
    ]);
    list();
    expect((await screen.findAllByRole("button", { name: /development v/ })).length).toBe(2);
  });

  it("shows the empty catalog", async () => {
    list();
    expect(await screen.findByText("No pinned definitions.")).toBeTruthy();
  });

  it("shows a failed catalog read", async () => {
    vi.mocked(fetchOperatorDefinitions).mockRejectedValue(new Error("server down"));
    list();
    expect((await screen.findByRole("alert")).textContent).toContain("server down");
  });

  it("opens the editor for a new definition", async () => {
    const onNew = vi.fn();
    list(onNew);
    await screen.findByText("No pinned definitions.");
    fireEvent.click(screen.getByRole("button", { name: "New definition" }));
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("passes the pinned bundle ID when cloning", async () => {
    const onClone = vi.fn();
    vi.mocked(fetchOperatorDefinitions).mockResolvedValue([makeDefinitionSummary()]);
    list(vi.fn(), vi.fn(), onClone);
    fireEvent.click(await screen.findByRole("button", { name: "Clone" }));
    expect(onClone).toHaveBeenCalledWith("bundle-1");
  });

  it("opens a pinned definition by bundle ID", async () => {
    const onSelect = vi.fn();
    vi.mocked(fetchOperatorDefinitions).mockResolvedValue([makeDefinitionSummary()]);
    list(vi.fn(), onSelect);
    fireEvent.click(await screen.findByRole("button", { name: /development v/ }));
    expect(onSelect).toHaveBeenCalledWith("bundle-1");
  });
});

describe("pinned definition detail", () => {
  it("shows the definition's unit labels", async () => {
    vi.mocked(fetchOperatorDefinitions).mockImplementation(async () => [makeDefinitionSummary()]);
    show(<WorkflowDefDetailView definitionId="bundle-1" onBack={() => undefined} onClone={() => undefined} />);
    const detail = await screen.findByTestId("or-def-detail");
    expect(detail.textContent).toContain("Development");
    expect(detail.querySelectorAll("li").length).toBeGreaterThan(0);
  });
});

describe("pinned definition editor", () => {
  it("renders an empty workflow editor for a new definition", () => {
    editor();
    expect(screen.getByTestId("or-def-editor")).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>("Workflow JSON").value).toBe("");
  });

  it("shows loading while the clone source is pending", () => {
    vi.mocked(fetchOperatorDefinitionDetail).mockImplementation(() => new Promise(() => undefined));
    editor("bundle-1");
    expect(screen.getByRole("status").textContent).toContain("Loading definition");
  });

  it("reports a failed clone-source read", async () => {
    vi.mocked(fetchOperatorDefinitionDetail).mockRejectedValue(new Error("not found"));
    editor("missing");
    expect((await screen.findByRole("alert")).textContent).toContain("not found");
  });

  it("offers compilation of the workflow", () => {
    editor();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Compile definition" }).disabled).toBe(false);
  });

  it("requires a workflow before compiling", () => {
    editor();
    expect(screen.getByLabelText<HTMLTextAreaElement>("Workflow JSON").checkValidity()).toBe(false);
  });

  it("clones the pinned workflow under a new name", async () => {
    vi.mocked(fetchOperatorDefinitionDetail).mockResolvedValue(makeDefinitionDetail({ workflow: makeWorkflowSource({ workflow: "v2_staged" }) }));
    editor("bundle-1");
    expect((await screen.findByDisplayValue(/"workflow": "v2_staged_copy"/))).toBeTruthy();
  });
});
