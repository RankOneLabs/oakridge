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
    await waitFor(() => {
      expect(screen.getByLabelText("Agent")).toHaveProperty("value", "claude-code");
    });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Build the thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        project_id: "project-1",
        title: "Build the thing",
        agent_runtime: "claude-code",
      });
    });
  });

  test("submits notes loaded from an uploaded file", async () => {
    let postBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/config") {
        return new Response(
          JSON.stringify({
            defaultWorkdir: "/tmp/repo",
            defaultRuntimeId: "claude-code",
            runtimes: [
              {
                id: "claude-code",
                label: "Claude Code",
                supportsCompaction: true,
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
      expect(screen.getByLabelText("Agent")).toHaveProperty("value", "claude-code");
    });

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "From a file" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    const content = "spec from file\nline two";
    const file = new File([content], "spec.md", { type: "text/markdown" });
    // jsdom's File.text() is unreliable; provide a working implementation.
    Object.defineProperty(file, "text", { value: async () => content });
    fireEvent.change(screen.getByLabelText("Notes file"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Notes preview")).toHaveProperty(
        "value",
        "spec from file\nline two",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        project_id: "project-1",
        title: "From a file",
        notes: "spec from file\nline two",
        agent_runtime: "claude-code",
      });
    });
  });

  test("clears uploaded file notes when reading a replacement file fails", async () => {
    let postBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/config") {
        return new Response(
          JSON.stringify({
            defaultWorkdir: "/tmp/repo",
            defaultRuntimeId: "claude-code",
            runtimes: [
              {
                id: "claude-code",
                label: "Claude Code",
                supportsCompaction: true,
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
      expect(screen.getByLabelText("Agent")).toHaveProperty("value", "claude-code");
    });

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "From a file" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    const firstContent = "spec from file";
    const firstFile = new File([firstContent], "spec.md", { type: "text/markdown" });
    Object.defineProperty(firstFile, "text", { value: async () => firstContent });
    fireEvent.change(screen.getByLabelText("Notes file"), {
      target: { files: [firstFile] },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Notes preview")).toHaveProperty("value", firstContent);
    });

    const failedFile = new File([""], "broken.md", { type: "text/markdown" });
    Object.defineProperty(failedFile, "text", {
      value: async () => {
        throw new Error("read failed");
      },
    });
    fireEvent.change(screen.getByLabelText("Notes file"), {
      target: { files: [failedFile] },
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("could not read file");
    });
    expect(screen.queryByLabelText("Notes preview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        project_id: "project-1",
        title: "From a file",
        agent_runtime: "claude-code",
      });
    });
    expect(postBody).not.toHaveProperty("notes");
  });

  test("clears the file input after a failed read so the same file can be retried", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/config") {
        return new Response(
          JSON.stringify({
            defaultWorkdir: "/tmp/repo",
            defaultRuntimeId: "claude-code",
            runtimes: [
              {
                id: "claude-code",
                label: "Claude Code",
                supportsCompaction: true,
                models: [],
              },
            ],
          }),
          { status: 200 },
        );
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
      expect(screen.getByLabelText("Agent")).toHaveProperty("value", "claude-code");
    });

    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    const fileInput = screen.getByLabelText("Notes file") as HTMLInputElement;
    Object.defineProperty(fileInput, "value", {
      configurable: true,
      writable: true,
      value: "C:\\fakepath\\broken.md",
    });
    const failedFile = new File([""], "broken.md", { type: "text/markdown" });
    Object.defineProperty(failedFile, "text", {
      value: async () => {
        throw new Error("read failed");
      },
    });

    fireEvent.change(fileInput, {
      target: { files: [failedFile] },
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("could not read file");
    });
    expect(fileInput.value).toBe("");
  });

  test("clears manually entered notes when switching to file upload mode", async () => {
    let postBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/config") {
        return new Response(
          JSON.stringify({
            defaultWorkdir: "/tmp/repo",
            defaultRuntimeId: "claude-code",
            runtimes: [
              {
                id: "claude-code",
                label: "Claude Code",
                supportsCompaction: true,
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
      expect(screen.getByLabelText("Agent")).toHaveProperty("value", "claude-code");
    });

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "From file mode" },
    });
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "manual notes should not submit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    expect(screen.queryByLabelText("Notes preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        project_id: "project-1",
        title: "From file mode",
        agent_runtime: "claude-code",
      });
    });
    expect(postBody).not.toHaveProperty("notes");
  });

  test("clears the uploaded file name when notes are edited manually", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/config") {
        return new Response(
          JSON.stringify({
            defaultWorkdir: "/tmp/repo",
            defaultRuntimeId: "claude-code",
            runtimes: [
              {
                id: "claude-code",
                label: "Claude Code",
                supportsCompaction: true,
                models: [],
              },
            ],
          }),
          { status: 200 },
        );
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
      expect(screen.getByLabelText("Agent")).toHaveProperty("value", "claude-code");
    });

    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    const content = "spec from file";
    const file = new File([content], "spec.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => content });
    fireEvent.change(screen.getByLabelText("Notes file"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByText("Loaded spec.md — 14 chars")).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "manual changes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    expect(screen.queryByText(/Loaded spec\.md/)).toBeNull();
  });

  test("defaults to the first available runtime when configured default is absent", async () => {
    let postBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/config") {
        return new Response(
          JSON.stringify({
            defaultWorkdir: "/tmp/repo",
            defaultRuntimeId: "claude-code",
            runtimes: [
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
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Build the thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        agent_runtime: "codex",
      });
    });
  });
});
