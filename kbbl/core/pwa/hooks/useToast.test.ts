import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useToastStore } from "./useToast";

describe("useToast store", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushToast appends a toast", () => {
    useToastStore.getState().pushToast({ kind: "success", message: "Merged." });
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("success");
    expect(toasts[0].message).toBe("Merged.");
  });

  it("dismissToast removes the toast by id", () => {
    useToastStore.getState().pushToast({ kind: "info", message: "Hello" });
    const { id } = useToastStore.getState().toasts[0];
    useToastStore.getState().dismissToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("toast auto-dismisses after ttlMs elapses", () => {
    useToastStore.getState().pushToast({ kind: "error", message: "Failed", ttlMs: 1000 });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("toast does not auto-dismiss before ttlMs elapses", () => {
    useToastStore.getState().pushToast({ kind: "error", message: "Failed", ttlMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
