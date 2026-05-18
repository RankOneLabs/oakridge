import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useViewport } from "./useViewport";

function makeMatchMedia() {
  const listeners = new Map<string, Set<(e: MediaQueryListEvent) => void>>();
  return vi.fn((query: string) => ({
    matches: false,
    media: query,
    addEventListener: (type: string, cb: any) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type: string, cb: any) => {
      listeners.get(type)?.delete(cb);
    },
    __listeners: listeners,
  }));
}

describe("useViewport", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", makeMatchMedia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initial derivation at phone width", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 380 });
    const { result } = renderHook(() => useViewport());
    expect(result.current).toEqual({ width: 380, isPhone: true, isTablet: false, isDesktop: false });
  });

  it("initial derivation at tablet width", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 800 });
    const { result } = renderHook(() => useViewport());
    expect(result.current).toEqual({ width: 800, isPhone: false, isTablet: true, isDesktop: false });
  });

  it("initial derivation at desktop width", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1440,
    });
    const { result } = renderHook(() => useViewport());
    expect(result.current).toEqual({
      width: 1440,
      isPhone: false,
      isTablet: false,
      isDesktop: true,
    });
  });

  it("resize-driven update", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 380 });
    const { result } = renderHook(() => useViewport());
    expect(result.current.isPhone).toBe(true);

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1440,
    });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current.isDesktop).toBe(true);
    expect(result.current.isPhone).toBe(false);
  });

  it("listener cleanup on unmount", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 380 });
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useViewport());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});
