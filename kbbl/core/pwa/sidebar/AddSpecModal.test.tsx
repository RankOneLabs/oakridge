import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type React from "react";

import { AddSpecModal } from "./AddSpecModal";

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("AddSpecModal agent runtime selection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("submits selected agent runtime when creating a flow", async () => {
    let postBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/config") {
        return new Response(
          JSON.stringify({
            defaultWorkdir: "/tmp/repo",
            defaultRuntimeId: "codex",
            runtimes: [
              {
                id: "claude-code",
                label: "Claude Code",
                supportsCompaction: true,
                models: [],
              },
              {
                id: "codex",
                label: "Codex",
                supportsCompaction: false,
                models: [],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "/specs" && init?.method === "POST") {
        postBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ id: "spec-1" }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(
      <AddSpecModal
        project={{ id: "project-1", name: "Project", repo_path: "/tmp/repo" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Agent")).toHaveProperty("value", "codex");
    });

    fireEvent.change(screen.getByLabelText("Agent"), {
      target: { value: "claude-code" },
    });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Build the thing" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        project_id: "project-1",
        title: "Build the thing",
        agent_runtime: "claude-code",
      });
    });
  });
});
