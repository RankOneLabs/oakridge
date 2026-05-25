import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  newSessionModelKey,
  readStoredNewSessionModel,
  writeStoredNewSessionModel,
} from "./storage";

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

const originalLocalStorage = globalThis.localStorage;

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: originalLocalStorage,
  });
});

describe("new session model storage", () => {
  test("coerces unsupported Codex model writes to runtime default", () => {
    writeStoredNewSessionModel("claude-sonnet-4-6", "codex");

    expect(localStorage.getItem(newSessionModelKey("codex"))).toBe("");
    expect(readStoredNewSessionModel("codex")).toBe("");
  });

  test("preserves supported Claude model writes", () => {
    writeStoredNewSessionModel("claude-opus-4-7", "claude-code");

    expect(localStorage.getItem(newSessionModelKey("claude-code"))).toBe(
      "claude-opus-4-7",
    );
    expect(readStoredNewSessionModel("claude-code")).toBe("claude-opus-4-7");
  });
});
