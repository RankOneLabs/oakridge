import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { RuntimeDescriptor } from "../../types";
import { newSessionModelKey } from "../../lib/storage";
import { NewSessionForm, type NewSessionFormValues } from "./NewSessionForm";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

const runtimes: RuntimeDescriptor[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    supportsCompaction: true,
    models: [
      { value: "claude-sonnet-4-6", label: "sonnet 4.6" },
      { value: "claude-opus-4-7", label: "opus 4.7" },
    ],
    efforts: [
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    supportsCompaction: false,
    models: [
      { value: "gpt-5.1-codex", label: "gpt-5.1-codex" },
    ],
    efforts: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
    ],
  },
];

function renderForm(onSubmit: (values: NewSessionFormValues) => void): void {
  render(
    <NewSessionForm
      defaultWorkdir="/tmp"
      defaultRuntimeId="claude-code"
      runtimes={runtimes}
      initialWorkdir={null}
      workdirTouchedInitial={false}
      pending={false}
      pendingError={null}
      autostartPending={false}
      onAutostartConsumed={() => {}}
      resetSignal={0}
      onSubmit={onSubmit}
    />,
  );
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

afterEach(() => {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    return;
  }
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("NewSessionForm runtime model selection", () => {
  test("switching runtime changes model options", () => {
    renderForm(() => {});

    const modelSelect = screen.getByLabelText("Model for new session");
    expect(modelSelect.textContent).toContain("sonnet 4.6");
    expect(modelSelect.textContent).not.toContain("gpt-5.1-codex");

    fireEvent.change(screen.getByLabelText("Runtime for new session"), {
      target: { value: "codex" },
    });

    expect(modelSelect.textContent).toContain("gpt-5.1-codex");
    expect(modelSelect.textContent).not.toContain("sonnet 4.6");
  });

  test("submit includes selected runtime and model", () => {
    let submitted: NewSessionFormValues | null = null;
    renderForm((values) => {
      submitted = values;
    });

    fireEvent.change(screen.getByLabelText("Runtime for new session"), {
      target: { value: "codex" },
    });
    fireEvent.change(screen.getByLabelText("Model for new session"), {
      target: { value: "gpt-5.1-codex" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "+ New" }));

    expect(submitted).toMatchObject({
      workdir: "/tmp",
      runtimeId: "codex",
      model: "gpt-5.1-codex",
    });
  });

  test("switching runtime preserves stored model preference", async () => {
    localStorage.setItem(newSessionModelKey("codex"), "gpt-5.1-codex");
    renderForm(() => {});

    fireEvent.change(screen.getByLabelText("Runtime for new session"), {
      target: { value: "codex" },
    });

    expect(screen.getByLabelText("Model for new session")).toHaveProperty(
      "value",
      "gpt-5.1-codex",
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Model for new session")).toHaveProperty(
        "value",
        "gpt-5.1-codex",
      );
    });
    expect(localStorage.getItem(newSessionModelKey("codex"))).toBe("gpt-5.1-codex");
  });
});
