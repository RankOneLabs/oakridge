import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoScrollAndLayout } from "./useAutoScrollAndLayout";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("updates the surface clearance as the bars resize and clears it for an empty composer", () => {
  const app = document.createElement("div");
  const top = document.createElement("header");
  const bottom = document.createElement("div");
  vi.spyOn(top, "offsetHeight", "get").mockReturnValue(48);
  const height = vi.spyOn(bottom, "offsetHeight", "get").mockReturnValue(96);
  const observe = vi.fn();
  const disconnect = vi.fn();
  let resize = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });

  const { unmount } = renderHook(() => useAutoScrollAndLayout({
    appRef: { current: app }, topBarRef: { current: top }, bottomBarRef: { current: bottom },
  }));
  expect(app.style.getPropertyValue("--top-bar-h")).toBe("48px");
  expect(app.style.getPropertyValue("--bottom-bar-h")).toBe("96px");
  expect(observe).toHaveBeenCalledWith(bottom);

  height.mockReturnValue(120);
  act(resize);
  expect(app.style.getPropertyValue("--bottom-bar-h")).toBe("120px");
  height.mockReturnValue(0);
  act(resize);
  expect(app.style.getPropertyValue("--bottom-bar-h")).toBe("");
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
