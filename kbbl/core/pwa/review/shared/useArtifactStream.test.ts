import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useArtifactStream } from "./useArtifactStream";
import type { AtomEdit, Thread } from "./types";

// ---- EventSource mock ----

interface MockESInstance {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  listeners: Map<string, ((e: MessageEvent) => void)[]>;
  close: ReturnType<typeof vi.fn>;
  dispatchEvent: (type: string, data: unknown) => void;
}

let mockES: MockESInstance | null = null;

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Map<string, ((e: MessageEvent) => void)[]> = new Map();
  close = vi.fn();

  constructor(_url: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    mockES = this as unknown as MockESInstance;
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, fn]);
  }

  dispatchEvent(type: string, data: unknown) {
    const fns = this.listeners.get(type) ?? [];
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const fn of fns) fn(event);
  }
}

// ---- fetch mock ----

function makeEditRow(anchor: string | null, newValue: string): AtomEdit {
  return {
    id: crypto.randomUUID(),
    target_type: "plan",
    target_id: "plan-1",
    anchor,
    prior_value: null,
    new_value: newValue,
    author: "bot",
    created_at: new Date().toISOString(),
  };
}

function makeThread(anchor: string | null): Thread {
  return {
    id: crypto.randomUUID(),
    target_type: "plan",
    target_id: "plan-1",
    anchor,
    author: null,
    status: "open",
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  mockES = null;
  // @ts-expect-error replacing global
  global.EventSource = MockEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useArtifactStream", () => {
  it("starts in idle state", () => {
    const initialEdits: AtomEdit[] = [];
    const initialThreads: Thread[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockImplementation(async () => {
          return {};
        }),
      }),
    );

    const { result } = renderHook(() =>
      useArtifactStream("plan", "plan-1"),
    );

    expect(result.current.status).toBe("idle");
    expect(result.current.edits).toEqual(initialEdits);
    expect(result.current.threads).toEqual(initialThreads);
    expect(result.current.frozen).toBe(false);
  });

  it("populates edits, threads, and frozen from initial GET responses", async () => {
    const edits = [makeEditRow("goal", "hello")];
    const threads = [makeThread("notes")];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/atoms/edits")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(edits) });
        }
        if (url.includes("/threads")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(threads) });
        }
        if (url.includes("/review/frozen")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ frozen: true }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    const { result } = renderHook(() =>
      useArtifactStream("plan", "plan-1"),
    );

    // Let promises settle
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.edits).toEqual(edits);
    expect(result.current.threads).toEqual(threads);
    expect(result.current.frozen).toBe(true);
  });

  it("transitions to connected when SSE opens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      }),
    );

    // Also mock /review/frozen
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/review/frozen")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ frozen: false }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }),
    );

    const { result } = renderHook(() =>
      useArtifactStream("plan", "plan-1"),
    );

    await act(async () => {
      mockES?.onopen?.();
    });

    expect(result.current.status).toBe("connected");
  });

  it("integrates atom_edit.applied SSE events into edits state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/review/frozen")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ frozen: false }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }),
    );

    const { result } = renderHook(() =>
      useArtifactStream("plan", "plan-1"),
    );

    await act(async () => {
      await Promise.resolve();
    });

    const newEdit = makeEditRow("goal", "updated");
    await act(async () => {
      mockES?.dispatchEvent("atom_edit.applied", {
        ...newEdit,
        target_type: "plan",
        target_id: "plan-1",
      });
    });

    expect(result.current.edits).toHaveLength(1);
    expect(result.current.edits[0].new_value).toBe("updated");
  });

  it("marks frozen=true on artifact.frozen SSE event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/review/frozen")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ frozen: false }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }),
    );

    const { result } = renderHook(() =>
      useArtifactStream("plan", "plan-1"),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.frozen).toBe(false);

    await act(async () => {
      mockES?.dispatchEvent("artifact.frozen", {
        target_type: "plan",
        target_id: "plan-1",
      });
    });

    expect(result.current.frozen).toBe(true);
  });
});
