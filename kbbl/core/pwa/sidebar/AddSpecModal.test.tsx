// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type React from "react";

import { AddSpecModal } from "./AddSpecModal";

const originalFetch = globalThis.fetch;

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

type Config = {
  defaultWorkdir: string;
  defaultRuntimeId: string;
  runtimes: Array<{
    id: string;
    label: string;
    supportsCompaction: boolean;
    models: Array<{ value: string; label: string }>;
  }>;
};

function stubFetch(config: Config, onCreate?: (body: unknown) => void) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/config") {
      return new Response(JSON.stringify(config), { status: 200 });
    }
    if (url === "/specs" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      onCreate?.(body);
      return new Response(JSON.stringify({ id: "spec-1" }), { status: 201 });
    }
    return new Response("not found", { status: 404 });
  });
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

function getSelectOptions(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.value);
}

describe("AddSpecModal split role selection", () => {
  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    }
  });

  test("defaults planner and worker independently and submits split model selections", async () => {
    let postBody: unknown = null;
    stubFetch(
      {
        defaultWorkdir: "/tmp/repo",
        defaultRuntimeId: "codex",
        runtimes: [
          {
            id: "claude-code",
            label: "Claude Code",
            supportsCompaction: true,
            models: [
              { value: "claude-opus-4-8", label: "opus 4.8" },
              { value: "claude-sonnet-4-6", label: "sonnet 4.6" },
            ],
          },
          {
            id: "codex",
            label: "Codex",
            supportsCompaction: false,
            models: [
              { value: "gpt-5.5", label: "gpt-5.5" },
              { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
            ],
          },
        ],
      },
      (body) => {
        postBody = body;
      },
    );

    renderWithClient(
      <AddSpecModal
        project={{ id: "project-1", name: "Project", repo_path: "/tmp/repo" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "codex");
    });

    expect(screen.getByLabelText("Planner model")).toHaveProperty("value", "gpt-5.5");
    expect(screen.getByLabelText("Worker runtime")).toHaveProperty("value", "codex");
    expect(screen.getByLabelText("Worker model")).toHaveProperty("value", "gpt-5.4-mini");

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Build the thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        project_id: "project-1",
        title: "Build the thing",
        planner_model_selection: { runtime: "codex", model: "gpt-5.5" },
        worker_model_selection: { runtime: "codex", model: "gpt-5.4-mini" },
      });
    });
    expect(postBody).not.toHaveProperty("agent_runtime");
  });

  test("keeps planner and worker model scopes independent when runtimes change", async () => {
    stubFetch({
      defaultWorkdir: "/tmp/repo",
      defaultRuntimeId: "codex",
      runtimes: [
        {
          id: "claude-code",
          label: "Claude Code",
          supportsCompaction: true,
          models: [
            { value: "claude-opus-4-8", label: "opus 4.8" },
            { value: "claude-sonnet-4-6", label: "sonnet 4.6" },
          ],
        },
        {
          id: "codex",
          label: "Codex",
          supportsCompaction: false,
          models: [
            { value: "gpt-5.5", label: "gpt-5.5" },
            { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
          ],
        },
      ],
    });

    renderWithClient(
      <AddSpecModal
        project={{ id: "project-1", name: "Project", repo_path: "/tmp/repo" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "codex");
    });

    fireEvent.change(screen.getByLabelText("Planner runtime"), {
      target: { value: "claude-code" },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "claude-code");
    });
    expect(screen.getByLabelText("Planner model")).toHaveProperty("value", "claude-opus-4-8");
    expect(getSelectOptions(screen.getByLabelText("Planner model") as HTMLSelectElement)).toEqual([
      "",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ]);
    expect(screen.getByLabelText("Worker runtime")).toHaveProperty("value", "codex");
    expect(screen.getByLabelText("Worker model")).toHaveProperty("value", "gpt-5.4-mini");
    expect(getSelectOptions(screen.getByLabelText("Worker model") as HTMLSelectElement)).toEqual([
      "",
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);

    fireEvent.change(screen.getByLabelText("Worker runtime"), {
      target: { value: "claude-code" },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Worker runtime")).toHaveProperty("value", "claude-code");
    });
    expect(screen.getByLabelText("Worker model")).toHaveProperty("value", "claude-sonnet-4-6");
    expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "claude-code");
    expect(screen.getByLabelText("Planner model")).toHaveProperty("value", "claude-opus-4-8");
  });

  test("keeps the model field editable when a runtime exposes no enumerable models", async () => {
    let postBody: unknown = null;
    stubFetch(
      {
        defaultWorkdir: "/tmp/repo",
        defaultRuntimeId: "codex",
        runtimes: [
          {
            id: "codex",
            label: "Codex",
            supportsCompaction: false,
            models: [],
          },
        ],
      },
      (body) => {
        postBody = body;
      },
    );

    renderWithClient(
      <AddSpecModal
        project={{ id: "project-1", name: "Project", repo_path: "/tmp/repo" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "codex");
    });
    expect(screen.getByLabelText("Planner model").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Worker model").tagName).toBe("INPUT");

    fireEvent.change(screen.getByLabelText("Planner model"), {
      target: { value: "custom-planner-model" },
    });
    fireEvent.change(screen.getByLabelText("Worker model"), {
      target: { value: "custom-worker-model" },
    });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "No model runtime" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        title: "No model runtime",
        planner_model_selection: { runtime: "codex", model: "custom-planner-model" },
        worker_model_selection: { runtime: "codex", model: "custom-worker-model" },
      });
    });
  });

  test("submits notes loaded from an uploaded file", async () => {
    let postBody: unknown = null;
    stubFetch(
      {
        defaultWorkdir: "/tmp/repo",
        defaultRuntimeId: "codex",
        runtimes: [
          {
            id: "codex",
            label: "Codex",
            supportsCompaction: false,
            models: [
              { value: "gpt-5.5", label: "gpt-5.5" },
              { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
            ],
          },
        ],
      },
      (body) => {
        postBody = body;
      },
    );

    renderWithClient(
      <AddSpecModal
        project={{ id: "project-1", name: "Project", repo_path: "/tmp/repo" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "codex");
    });

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "From a file" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    const content = "spec from file\nline two";
    const file = new File([content], "spec.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => content });
    fireEvent.change(screen.getByLabelText("Notes file"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Notes preview")).toHaveProperty("value", content);
    });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        title: "From a file",
        notes: "spec from file\nline two",
        planner_model_selection: { runtime: "codex", model: "gpt-5.5" },
        worker_model_selection: { runtime: "codex", model: "gpt-5.4-mini" },
      });
    });
  });
});
