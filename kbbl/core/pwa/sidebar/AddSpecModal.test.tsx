import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { AddSpecModal } from "./AddSpecModal";

const CC_RUNTIME = {
  id: "claude-code",
  label: "Claude Code",
  models: [
    { value: "claude-opus-4-8", label: "Opus 4.8" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  ],
  supportsCompaction: true,
};

const CODEX_RUNTIME = {
  id: "codex",
  label: "Codex",
  models: [{ value: "gpt-5.1-codex", label: "gpt-5.1-codex" }],
  supportsCompaction: false,
};

function makeConfig(withCodex = false) {
  return {
    defaultWorkdir: "/tmp",
    defaultRuntimeId: "claude-code",
    runtimes: withCodex ? [CC_RUNTIME, CODEX_RUNTIME] : [CC_RUNTIME],
    stageDefaults: {
      planner: { runtime: "claude-code", model: "claude-opus-4-8" },
      build: { runtime: "claude-code", model: "claude-sonnet-4-6" },
    },
  };
}

function makeFetch(withCodex = false, onSpecsPost?: (body: unknown) => void) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/config") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeConfig(withCodex)),
      });
    }
    if (url === "/specs" && (init as RequestInit & { method?: string })?.method === "POST") {
      if (onSpecsPost && init?.body) {
        onSpecsPost(JSON.parse(init.body as string) as unknown);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

function renderModal(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const PROJECT = { id: "proj-1", name: "Test Project", repo_path: "/home/user/test-project" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AddSpecModal routing selects", () => {
  it("pre-selects Planner model to stageDefaults.planner", async () => {
    vi.stubGlobal("fetch", makeFetch());
    renderModal(
      <AddSpecModal project={PROJECT} onCreated={() => {}} onCancel={() => {}} />,
    );

    const plannerSelect = screen.getByRole("combobox", { name: "Planner model" });
    await waitFor(() => {
      expect((plannerSelect as HTMLSelectElement).value).toBe(
        "claude-code::claude-opus-4-8",
      );
    });
  });

  it("pre-selects Build model to stageDefaults.build", async () => {
    vi.stubGlobal("fetch", makeFetch());
    renderModal(
      <AddSpecModal project={PROJECT} onCreated={() => {}} onCancel={() => {}} />,
    );

    const buildSelect = screen.getByRole("combobox", { name: "Build model" });
    await waitFor(() => {
      expect((buildSelect as HTMLSelectElement).value).toBe(
        "claude-code::claude-sonnet-4-6",
      );
    });
  });

  it("shows Codex optgroup when codex is in config runtimes", async () => {
    vi.stubGlobal("fetch", makeFetch(true));
    renderModal(
      <AddSpecModal project={PROJECT} onCreated={() => {}} onCancel={() => {}} />,
    );

    await waitFor(() => {
      const allOptions = screen.getAllByRole("option");
      const codexOptions = allOptions.filter(
        (o) => o.textContent === "gpt-5.1-codex",
      );
      expect(codexOptions.length).toBeGreaterThan(0);
    });
  });

  it("does not show Codex optgroup when codex is absent from config runtimes", async () => {
    vi.stubGlobal("fetch", makeFetch(false));
    renderModal(
      <AddSpecModal project={PROJECT} onCreated={() => {}} onCancel={() => {}} />,
    );

    // Wait for config to load (CC options visible)
    await waitFor(() => {
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    });

    const allOptions = screen.getAllByRole("option");
    const codexOptions = allOptions.filter(
      (o) => o.textContent === "gpt-5.1-codex",
    );
    expect(codexOptions.length).toBe(0);
  });

  it("omits planner and build routing when selects are untouched", async () => {
    const capturedBodies: unknown[] = [];
    vi.stubGlobal("fetch", makeFetch(false, (body) => capturedBodies.push(body)));
    renderModal(
      <AddSpecModal project={PROJECT} onCreated={() => {}} onCancel={() => {}} />,
    );

    // Wait for config to load
    await waitFor(() => {
      expect(
        (screen.getByRole("combobox", { name: "Planner model" }) as HTMLSelectElement).value,
      ).toBe("claude-code::claude-opus-4-8");
    });

    fireEvent.change(screen.getByPlaceholderText("Short one-line summary"), {
      target: { value: "My Epic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(capturedBodies.length).toBe(1));
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.planner_runtime).toBeUndefined();
    expect(body.planner_model).toBeUndefined();
    expect(body.build_runtime).toBeUndefined();
    expect(body.build_model).toBeUndefined();
  });

  it("posts planner pair when planner is changed from default", async () => {
    const capturedBodies: unknown[] = [];
    vi.stubGlobal("fetch", makeFetch(false, (body) => capturedBodies.push(body)));
    renderModal(
      <AddSpecModal project={PROJECT} onCreated={() => {}} onCancel={() => {}} />,
    );

    await waitFor(() => {
      expect(
        (screen.getByRole("combobox", { name: "Planner model" }) as HTMLSelectElement).value,
      ).toBe("claude-code::claude-opus-4-8");
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Planner model" }), {
      target: { value: "claude-code::claude-sonnet-4-6" },
    });

    fireEvent.change(screen.getByPlaceholderText("Short one-line summary"), {
      target: { value: "My Epic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(capturedBodies.length).toBe(1));
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.planner_runtime).toBe("claude-code");
    expect(body.planner_model).toBe("claude-sonnet-4-6");
    expect(body.build_runtime).toBeUndefined();
    expect(body.build_model).toBeUndefined();
  });

  it("posts build pair when build is changed from default", async () => {
    const capturedBodies: unknown[] = [];
    vi.stubGlobal("fetch", makeFetch(false, (body) => capturedBodies.push(body)));
    renderModal(
      <AddSpecModal project={PROJECT} onCreated={() => {}} onCancel={() => {}} />,
    );

    await waitFor(() => {
      expect(
        (screen.getByRole("combobox", { name: "Build model" }) as HTMLSelectElement).value,
      ).toBe("claude-code::claude-sonnet-4-6");
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Build model" }), {
      target: { value: "claude-code::claude-opus-4-8" },
    });

    fireEvent.change(screen.getByPlaceholderText("Short one-line summary"), {
      target: { value: "My Epic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(capturedBodies.length).toBe(1));
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.planner_runtime).toBeUndefined();
    expect(body.planner_model).toBeUndefined();
    expect(body.build_runtime).toBe("claude-code");
    expect(body.build_model).toBe("claude-opus-4-8");
  });

  it("omits routing when both selects are changed back to defaults", async () => {
    const capturedBodies: unknown[] = [];
    vi.stubGlobal("fetch", makeFetch(false, (body) => capturedBodies.push(body)));
    renderModal(
      <AddSpecModal project={PROJECT} onCreated={() => {}} onCancel={() => {}} />,
    );

    await waitFor(() => {
      expect(
        (screen.getByRole("combobox", { name: "Planner model" }) as HTMLSelectElement).value,
      ).toBe("claude-code::claude-opus-4-8");
    });

    // Change planner then change it back to the default
    fireEvent.change(screen.getByRole("combobox", { name: "Planner model" }), {
      target: { value: "claude-code::claude-sonnet-4-6" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Planner model" }), {
      target: { value: "claude-code::claude-opus-4-8" },
    });

    fireEvent.change(screen.getByPlaceholderText("Short one-line summary"), {
      target: { value: "My Epic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(capturedBodies.length).toBe(1));
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.planner_runtime).toBeUndefined();
    expect(body.planner_model).toBeUndefined();
  });
});
