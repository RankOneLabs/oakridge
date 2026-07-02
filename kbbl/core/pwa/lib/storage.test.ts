import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  newSessionModelKey,
  readStoredNewSessionModel,
  writeStoredNewSessionModel,
} from "./storage";
import type { RuntimeDescriptor } from "../types";

const claudeRuntime: RuntimeDescriptor = {
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
};

const codexRuntime: RuntimeDescriptor = {
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
};

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  clear(): void {
    this.values.clear();
  }
}

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

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

describe("new session model storage", () => {
  test("preserves supported Codex model writes", () => {
    const normalized = writeStoredNewSessionModel("gpt-5.1-codex", codexRuntime);

    expect(normalized).toBe("gpt-5.1-codex");
    expect(localStorage.getItem(newSessionModelKey("codex"))).toBe("gpt-5.1-codex");
    expect(readStoredNewSessionModel(codexRuntime)).toBe("gpt-5.1-codex");
  });

  test("coerces unsupported model writes to runtime default", () => {
    const normalized = writeStoredNewSessionModel("claude-sonnet-4-6", codexRuntime);

    expect(normalized).toBe("");
    expect(localStorage.getItem(newSessionModelKey("codex"))).toBe("");
    expect(readStoredNewSessionModel(codexRuntime)).toBe("");
  });

  test("preserves supported Claude model writes", () => {
    const normalized = writeStoredNewSessionModel("claude-opus-4-7", claudeRuntime);

    expect(normalized).toBe("claude-opus-4-7");
    expect(localStorage.getItem(newSessionModelKey("claude-code"))).toBe(
      "claude-opus-4-7",
    );
    expect(readStoredNewSessionModel(claudeRuntime)).toBe("claude-opus-4-7");
  });

  test("stores runtime preferences independently", () => {
    writeStoredNewSessionModel("claude-opus-4-7", claudeRuntime);
    writeStoredNewSessionModel("gpt-5.1-codex", codexRuntime);

    expect(readStoredNewSessionModel(claudeRuntime)).toBe("claude-opus-4-7");
    expect(readStoredNewSessionModel(codexRuntime)).toBe("gpt-5.1-codex");
  });
});
