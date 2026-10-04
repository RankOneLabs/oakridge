import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { WorkflowDefListView } from "../views/WorkflowDefListView";
import { WorkflowDefEditorView } from "../views/WorkflowDefEditorView";
import { WorkflowDefDetailView } from "../views/WorkflowDefDetailView";
import type { WorkflowDefFull } from "../types";
import canonicalDefinition from "../../../../../workflow-config/definitions/dev_flow_v15.json";
import { validateWorkflowDefinition } from "../lib/workflow-definition-form";
const parsed = validateWorkflowDefinition(JSON.stringify(canonicalDefinition));
if (!parsed.ok) throw new Error("invalid canonical fixture");

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrap(ui: ReactElement) {
  const client = makeClient();
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const DEF_FIXTURE: WorkflowDefFull = { id: "def-1", name: "v2_dev_flow", version: 3,
  definition: parsed.value, archived: false, created_at: "2026-07-01T00:00:00Z" };
const DEF_WITH_STAGES: WorkflowDefFull = { ...DEF_FIXTURE, id: "def-2", name: "v2_staged", version: 1 };

// ──────────────────────────────────────────────────────────────────────────────
// WorkflowDefListView
// ──────────────────────────────────────────────────────────────────────────────

describe("WorkflowDefListView", () => {
  it("shows loading state while defs are pending", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    wrap(<WorkflowDefListView onNew={() => {}} onSelect={() => {}} onClone={() => {}} />);
    expect(screen.getByTestId("or-def-list-loading")).toBeTruthy();
  });

  it("renders a row for each def", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([DEF_FIXTURE, DEF_WITH_STAGES]));
    wrap(<WorkflowDefListView onNew={() => {}} onSelect={() => {}} onClone={() => {}} />);
    const rows = await screen.findAllByTestId("or-def-row");
    expect(rows).toHaveLength(2);
  });

  it("shows empty state when no defs exist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([]));
    wrap(<WorkflowDefListView onNew={() => {}} onSelect={() => {}} onClone={() => {}} />);
    expect(await screen.findByTestId("or-def-list-empty")).toBeTruthy();
  });

  it("shows error state when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "server down" }, 500));
    wrap(<WorkflowDefListView onNew={() => {}} onSelect={() => {}} onClone={() => {}} />);
    expect(await screen.findByTestId("or-def-list-error")).toBeTruthy();
  });

  it("calls onNew when New Definition button is clicked", async () => {
    const onNew = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([]));
    wrap(<WorkflowDefListView onNew={onNew} onSelect={() => {}} onClone={() => {}} />);
    await screen.findByTestId("or-def-list-empty");
    fireEvent.click(screen.getByTestId("or-def-new-btn"));
    expect(onNew).toHaveBeenCalled();
  });

  it("calls onClone with the def when clone button is clicked", async () => {
    const onClone = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([DEF_FIXTURE]));
    wrap(<WorkflowDefListView onNew={() => {}} onSelect={() => {}} onClone={onClone} />);
    const cloneBtn = await screen.findByTestId("or-def-clone-btn");
    fireEvent.click(cloneBtn);
    expect(onClone).toHaveBeenCalledWith(expect.objectContaining({ id: "def-1" }));
  });

  it("opens a definition when its name is clicked", async () => {
    const onSelect = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([DEF_FIXTURE]));
    wrap(<WorkflowDefListView onNew={() => {}} onSelect={onSelect} onClone={() => {}} />);
    fireEvent.click(await screen.findByTestId("or-def-view-btn"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "def-1" }));
  });
});

describe("WorkflowDefDetailView", () => {
  it("shows canonical stages, prerequisites and workers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(DEF_WITH_STAGES));
    wrap(<WorkflowDefDetailView definitionId="def-2" onBack={() => {}} onClone={() => {}} />);

    expect(await screen.findByTestId("or-def-detail")).toBeTruthy();
    expect(screen.getAllByTestId("or-def-stage")).toHaveLength(6);
    expect(screen.getByText("planning")).toBeTruthy();
    expect(screen.getByText("Workers: build, assessment")).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// WorkflowDefEditor
// ──────────────────────────────────────────────────────────────────────────────

describe("WorkflowDefEditor", () => {
  function makeEditorFetch(opts: { def?: WorkflowDefFull; defError?: boolean } = {}) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/artifact_types")) return json([{ id: "spec_v2" }, { id: "build_output" }]);
      if (url.includes("/config")) return json({ available: true });
      if (url.includes("/workflow_defs/")) {
        if (opts.defError) return json({ error: "not found" }, 404);
        if (opts.def) return json(opts.def);
        return json({ error: "not found" }, 404);
      }
      return json([]);
    });
  }

  it("renders the editor for a new def when cloneFromId is null", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeEditorFetch());
    wrap(<WorkflowDefEditorView cloneFromId={null} onBack={() => {}} onCreated={() => {}} />);
    expect(await screen.findByTestId("or-def-editor")).toBeTruthy();
  });

  it("shows loading state while the clone source is fetching", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    wrap(<WorkflowDefEditorView cloneFromId="def-1" onBack={() => {}} onCreated={() => {}} />);
    expect(screen.getByTestId("or-def-editor-loading")).toBeTruthy();
  });

  it("shows error state when clone source fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeEditorFetch({ defError: true }));
    wrap(<WorkflowDefEditorView cloneFromId="missing" onBack={() => {}} onCreated={() => {}} />);
    expect(await screen.findByTestId("or-def-editor-load-error")).toBeTruthy();
  });

  it("refuses a retired graph rather than offering fan-out controls", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeEditorFetch());
    wrap(<WorkflowDefEditorView cloneFromId={null} onBack={() => {}} onCreated={() => {}} />);
    fireEvent.change(await screen.findByTestId("or-def-contract"), { target: { value: JSON.stringify({ graph: { stages: {}, edges: [] } }) } });
    expect((screen.getByTestId("or-def-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("or-def-validation-errors")).toBeTruthy();
  });

  it("clones the canonical contract and increments its immutable version", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeEditorFetch({ def: DEF_WITH_STAGES }));
    wrap(<WorkflowDefEditorView cloneFromId="def-2" onBack={() => {}} onCreated={() => {}} />);
    const source = await screen.findByTestId("or-def-contract") as HTMLTextAreaElement;
    expect(JSON.parse(source.value)).toEqual({ ...DEF_WITH_STAGES.definition, version: DEF_WITH_STAGES.version + 1 });
  });
});
