import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewRunForm } from "../NewRunForm";
import type { WorkflowDefSummary } from "../types";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderWithQueries(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => vi.restoreAllMocks());

describe("NewRunForm workflow definitions", () => {
  it("defaults to the newest definition and keeps fan-out definitions enabled", async () => {
    const definitions: WorkflowDefSummary[] = [
      { id: "v1", name: "dev-flow", version: 1 },
      {
        id: "v2",
        name: "dev-flow",
        version: 2,
        graph: {
          stages: {
            build: {
              stage_type: "delegated_session",
              config: {
                runtime: "codex",
                prompt_template_path: "build.md",
                slot_bindings: {},
                workdir: { from: "literal", value: "/tmp" },
                session_name: "build",
                fan_out: {
                  over: { from: "literal", value: "[]" },
                  unit_id_path: "/id",
                },
              },
              inputs: [],
              outputs: [],
            },
          },
          edges: [],
        },
      },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/config") {
        return json({ defaultWorkdir: null, runtimes: [] });
      }
      if (url === "/oakridge/config") {
        return json({ available: true, core_url: "http://oakridge.test" });
      }
      if (url === "/oakridge/api/projects") return json([]);
      if (url === "/oakridge/api/workflow_defs") return json(definitions);
      throw new Error(`unexpected request: ${url}`);
    });

    renderWithQueries(<NewRunForm onBack={() => {}} onCreated={() => {}} />);

    const newest = await screen.findByRole("option", { name: "dev-flow v2" });
    const select = newest.closest("select");
    expect(select?.value).toBe("v2");
    expect((newest as HTMLOptionElement).disabled).toBe(false);
  });
});
