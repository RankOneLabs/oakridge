import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArtifactId, Sid } from "../../lib/ids";
import { DEFAULT_RUN_WORKSPACE_STATE, LIST_PANE, OVERVIEW_PANE } from "./run-workspace";
import {
  pruneStoredRunWorkspace,
  readStoredRunWorkspace,
  runWorkspaceStorageKey,
  writeStoredRunWorkspace,
} from "./run-workspace-storage";

// Storage doubles installed on globalThis, following `core/pwa/lib/storage.test.ts`.
class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

/** A storage that refuses every operation, the way a sandboxed frame does. */
class ThrowingStorage {
  getItem(): string { throw new Error("SecurityError"); }
  setItem(): void { throw new Error("SecurityError"); }
  removeItem(): void { throw new Error("SecurityError"); }
}

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

const useStorage = (value: unknown): void => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value });
};

beforeEach(() => useStorage(new MemoryStorage()));

afterEach(() => {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    return;
  }
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("runWorkspaceStorageKey", () => {
  it("namespaces each run separately", () => {
    expect(runWorkspaceStorageKey("run-1")).toBe("kbbl.oakridge.runWorkspace.run-1");
    expect(runWorkspaceStorageKey("run-2")).not.toBe(runWorkspaceStorageKey("run-1"));
  });
});

describe("readStoredRunWorkspace falls back to the overview default", () => {
  it("when nothing is stored", () => {
    expect(readStoredRunWorkspace("run-1")).toEqual(DEFAULT_RUN_WORKSPACE_STATE);
  });

  it("when the stored value is not JSON", () => {
    localStorage.setItem(runWorkspaceStorageKey("run-1"), "{not json");

    expect(readStoredRunWorkspace("run-1")).toEqual(DEFAULT_RUN_WORKSPACE_STATE);
  });

  it("when the stored value is malformed JSON of the wrong type", () => {
    localStorage.setItem(runWorkspaceStorageKey("run-1"), JSON.stringify(["overview"]));

    expect(readStoredRunWorkspace("run-1")).toEqual(DEFAULT_RUN_WORKSPACE_STATE);
  });

  it("when the stored shape has no recognisable primary", () => {
    localStorage.setItem(
      runWorkspaceStorageKey("run-1"),
      JSON.stringify({ primary: { kind: "terminal" }, secondary: null }),
    );

    expect(readStoredRunWorkspace("run-1")).toEqual(DEFAULT_RUN_WORKSPACE_STATE);
  });

  it("when an entity pane carries no id", () => {
    localStorage.setItem(
      runWorkspaceStorageKey("run-1"),
      JSON.stringify({ primary: { kind: "artifact" }, secondary: null }),
    );

    expect(readStoredRunWorkspace("run-1")).toEqual(DEFAULT_RUN_WORKSPACE_STATE);
  });

  it("when localStorage itself throws", () => {
    useStorage(new ThrowingStorage());

    expect(readStoredRunWorkspace("run-1")).toEqual(DEFAULT_RUN_WORKSPACE_STATE);
  });
});

describe("readStoredRunWorkspace", () => {
  it("round-trips a twin arrangement", () => {
    const state = {
      primary: { kind: "session", session_id: "sid-1" as Sid } as const,
      secondary: { kind: "artifact", artifact_id: "art-1" as ArtifactId } as const,
    };
    writeStoredRunWorkspace("run-1", state);

    expect(readStoredRunWorkspace("run-1")).toEqual(state);
  });

  it("keeps a readable primary when only the secondary is corrupt", () => {
    localStorage.setItem(
      runWorkspaceStorageKey("run-1"),
      JSON.stringify({ primary: { kind: "list" }, secondary: { kind: "session" } }),
    );

    expect(readStoredRunWorkspace("run-1")).toEqual({ primary: LIST_PANE, secondary: null });
  });

  it("keeps each run's arrangement independent of the others", () => {
    writeStoredRunWorkspace("run-1", { primary: LIST_PANE, secondary: OVERVIEW_PANE });
    writeStoredRunWorkspace("run-2", { primary: OVERVIEW_PANE, secondary: null });

    expect(readStoredRunWorkspace("run-1")).toEqual({ primary: LIST_PANE, secondary: OVERVIEW_PANE });
    expect(readStoredRunWorkspace("run-2")).toEqual({ primary: OVERVIEW_PANE, secondary: null });
  });
});

describe("writeStoredRunWorkspace", () => {
  it("swallows a storage that refuses to write", () => {
    useStorage(new ThrowingStorage());

    expect(() => writeStoredRunWorkspace("run-1", DEFAULT_RUN_WORKSPACE_STATE)).not.toThrow();
  });
});

describe("pruneStoredRunWorkspace", () => {
  it("drops the run's entry so the next read is the default", () => {
    writeStoredRunWorkspace("run-1", { primary: LIST_PANE, secondary: null });
    pruneStoredRunWorkspace("run-1");

    expect(readStoredRunWorkspace("run-1")).toEqual(DEFAULT_RUN_WORKSPACE_STATE);
  });

  it("swallows a storage that refuses to remove", () => {
    useStorage(new ThrowingStorage());

    expect(() => pruneStoredRunWorkspace("run-1")).not.toThrow();
  });
});
