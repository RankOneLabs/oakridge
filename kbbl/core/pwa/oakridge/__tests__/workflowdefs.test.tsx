import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { WorkflowDefListView } from "../WorkflowDefListView";
import { WorkflowDefEditor } from "../WorkflowDefEditor";
import type { WorkflowDefFull } from "../types";

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

const DEF_FIXTURE: WorkflowDefFull = {
  id: "def-1",
  name: "v2_dev_flow",
  version: 3,
  graph: { stages: {}, edges: [] },
  created_at: "2026-07-01T00:00:00Z",
};

const DEF_WITH_STAGES: WorkflowDefFull = {
  id: "def-2",
  name: "v2_staged",
  version: 1,
  graph: {
    stages: {
      build: {
        stage_type: "delegated_session",
        config: {
          runtime: "claude-code",
          prompt_template_path: "build.md",
          slot_bindings: {},
          workdir: { from: "context", path: "/workdir" },
          session_name: "build-session",
          model: null,
          effort: null,
          worktree: null,
          pre_authorized_tools: [],
          yolo: false,
          fan_out: null,
          gate_output: null,
        },
        inputs: [{ name: "plan", artifact_type: "spec_v2" }],
        outputs: [{ name: "result", artifact_type: "build_output" }],
      },
    },
    edges: [],
  },
  created_at: "2026-07-01T01:00:00Z",
};

// ──────────────────────────────────────────────────────────────────────────────
// WorkflowDefListView
// ──────────────────────────────────────────────────────────────────────────────

describe("WorkflowDefListView", () => {
  it("shows loading state while defs are pending", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    wrap(<WorkflowDefListView onNew={() => {}} onClone={() => {}} />);
    expect(screen.getByTestId("or-def-list-loading")).toBeTruthy();
  });

  it("renders a row for each def", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([DEF_FIXTURE, DEF_WITH_STAGES]));
    wrap(<WorkflowDefListView onNew={() => {}} onClone={() => {}} />);
    const rows = await screen.findAllByTestId("or-def-row");
    expect(rows).toHaveLength(2);
  });

  it("shows empty state when no defs exist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([]));
    wrap(<WorkflowDefListView onNew={() => {}} onClone={() => {}} />);
    expect(await screen.findByTestId("or-def-list-empty")).toBeTruthy();
  });

  it("shows error state when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "server down" }, 500));
    wrap(<WorkflowDefListView onNew={() => {}} onClone={() => {}} />);
    expect(await screen.findByTestId("or-def-list-error")).toBeTruthy();
  });

  it("calls onNew when New Definition button is clicked", async () => {
    const onNew = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([]));
    wrap(<WorkflowDefListView onNew={onNew} onClone={() => {}} />);
    await screen.findByTestId("or-def-list-empty");
    fireEvent.click(screen.getByTestId("or-def-new-btn"));
    expect(onNew).toHaveBeenCalled();
  });

  it("calls onClone with the def when clone button is clicked", async () => {
    const onClone = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json([DEF_FIXTURE]));
    wrap(<WorkflowDefListView onNew={() => {}} onClone={onClone} />);
    const cloneBtn = await screen.findByTestId("or-def-clone-btn");
    fireEvent.click(cloneBtn);
    expect(onClone).toHaveBeenCalledWith(expect.objectContaining({ id: "def-1" }));
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
    wrap(<WorkflowDefEditor cloneFromId={null} onBack={() => {}} onCreated={() => {}} />);
    expect(await screen.findByTestId("or-def-editor")).toBeTruthy();
  });

  it("shows loading state while the clone source is fetching", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    wrap(<WorkflowDefEditor cloneFromId="def-1" onBack={() => {}} onCreated={() => {}} />);
    expect(screen.getByTestId("or-def-editor-loading")).toBeTruthy();
  });

  it("shows error state when clone source fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeEditorFetch({ defError: true }));
    wrap(<WorkflowDefEditor cloneFromId="missing" onBack={() => {}} onCreated={() => {}} />);
    expect(await screen.findByTestId("or-def-editor-load-error")).toBeTruthy();
  });

  it("submit is disabled when no stages are defined", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeEditorFetch());
    wrap(<WorkflowDefEditor cloneFromId={null} onBack={() => {}} onCreated={() => {}} />);
    await screen.findByTestId("or-def-editor");
    fireEvent.change(screen.getByTestId("or-def-name"), { target: { value: "my_flow" } });
    const btn = screen.getByTestId("or-def-submit") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("shows validation error when name is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeEditorFetch());
    wrap(<WorkflowDefEditor cloneFromId={null} onBack={() => {}} onCreated={() => {}} />);
    await screen.findByTestId("or-def-editor");
    // Name starts empty — validation errors panel should be present immediately
    expect(screen.getByTestId("or-def-validation-errors")).toBeTruthy();
  });

  it("populates form from clone source and bumps version", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeEditorFetch({ def: DEF_WITH_STAGES }));
    wrap(<WorkflowDefEditor cloneFromId="def-2" onBack={() => {}} onCreated={() => {}} />);
    // editor appears (not loading state) once data loads
    expect(await screen.findByTestId("or-def-editor")).toBeTruthy();
    // version field should show original + 1
    const versionInput = screen.getByTestId("or-def-version") as HTMLInputElement;
    expect(parseInt(versionInput.value, 10)).toBe(DEF_WITH_STAGES.version + 1);
    // name field should be pre-filled
    const nameInput = screen.getByTestId("or-def-name") as HTMLInputElement;
    expect(nameInput.value).toBe(DEF_WITH_STAGES.name);
  });
});
