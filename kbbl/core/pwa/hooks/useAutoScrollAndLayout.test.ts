import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";

import { useAutoScrollAndLayout } from "./useAutoScrollAndLayout";
import { STICK_TO_BOTTOM_THRESHOLD, type SessionSurfaceLayout } from "../lib/session-surface";

// The IO half of the surface: which host the hook listens to, measures, and
// scrolls. The stick decision itself is unit-tested in lib/session-surface.
// What matters here is only that the document layout never touches an element
// and the element layout never touches the window — a silent auto-scroll
// regression on the standalone view produces no error, so it has to be
// asserted rather than eyeballed.

const DOCUMENT_SCROLL_HEIGHT = 8000;

const stubDocumentGeometry = () => {
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(DOCUMENT_SCROLL_HEIGHT);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  vi.spyOn(window, "scrollY", "get").mockReturnValue(DOCUMENT_SCROLL_HEIGHT - 800);
};

const elementHost = (scrollHeight: number) => {
  const container = document.createElement("div");
  vi.spyOn(container, "scrollHeight", "get").mockReturnValue(scrollHeight);
  vi.spyOn(container, "clientHeight", "get").mockReturnValue(400);
  container.scrollTop = scrollHeight - 400;
  container.scrollTo = vi.fn();
  return container;
};

const inputsFor = (layout?: SessionSurfaceLayout) => ({
  sid: "sid-1",
  eventsLength: 1,
  pendingLength: 0,
  awaitingResult: false,
  sessionStatus: null,
  appRef: createRef<HTMLDivElement>(),
  topBarRef: createRef<HTMLElement>(),
  bottomBarRef: createRef<HTMLDivElement>(),
  ...(layout ? { layout } : {}),
});

afterEach(() => vi.restoreAllMocks());

describe("useAutoScrollAndLayout", () => {
  it("binds to the window, measures the document and scrolls it when given no layout", () => {
    stubDocumentGeometry();
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    const addEventListener = vi.spyOn(window, "addEventListener");

    renderHook(() => useAutoScrollAndLayout(inputsFor()));

    expect(addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function), { passive: true });
    expect(scrollTo).toHaveBeenCalledWith({ top: DOCUMENT_SCROLL_HEIGHT });
  });

  it("binds to the supplied container and scrolls it, never the window, when given an element layout", () => {
    stubDocumentGeometry();
    const windowScrollTo = vi.fn();
    window.scrollTo = windowScrollTo;
    const container = elementHost(1200);
    const addEventListener = vi.spyOn(container, "addEventListener");

    renderHook(() => useAutoScrollAndLayout(inputsFor({
      scrollHost: { kind: "element", container: { current: container } },
      barAnchor: "surface",
    })));

    expect(addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function), { passive: true });
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 1200 });
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it("releases the element host when the reader scrolls up beyond the threshold", () => {
    const container = elementHost(1200);
    container.scrollTop = 1200 - 400 - STICK_TO_BOTTOM_THRESHOLD - 1;
    const layout: SessionSurfaceLayout = {
      scrollHost: { kind: "element", container: { current: container } }, barAnchor: "surface",
    };
    const { rerender } = renderHook((eventsLength: number) => useAutoScrollAndLayout({ ...inputsFor(layout), eventsLength }), { initialProps: 1 });

    container.dispatchEvent(new Event("scroll"));
    (container.scrollTo as ReturnType<typeof vi.fn>).mockClear();
    rerender(2);

    expect(container.scrollTo).not.toHaveBeenCalled();
  });

  /** Sending re-sticks even from a scrolled-up position. */
  it("follows the element host again once the reader sends a message", () => {
    const container = elementHost(1200);
    container.scrollTop = 0;
    const layout: SessionSurfaceLayout = {
      scrollHost: { kind: "element", container: { current: container } }, barAnchor: "surface",
    };
    const { rerender } = renderHook((pendingLength: number) => useAutoScrollAndLayout({ ...inputsFor(layout), pendingLength }), { initialProps: 0 });

    container.dispatchEvent(new Event("scroll"));
    (container.scrollTo as ReturnType<typeof vi.fn>).mockClear();
    rerender(1);

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 1200 });
  });

  it("sets and re-measures the bar height vars on the surface root in both layouts", () => {
    stubDocumentGeometry();
    window.scrollTo = vi.fn();
    const app = document.createElement("div");
    const topBar = document.createElement("header");
    const bottomBar = document.createElement("div");
    vi.spyOn(topBar, "offsetHeight", "get").mockReturnValue(48);
    vi.spyOn(bottomBar, "offsetHeight", "get").mockReturnValue(96);
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      observe = observe;
      disconnect = vi.fn();
    });

    for (const layout of [undefined, { scrollHost: { kind: "element" as const, container: { current: elementHost(1200) } }, barAnchor: "surface" as const }]) {
      app.style.removeProperty("--top-bar-h");
      renderHook(() => useAutoScrollAndLayout({
        ...inputsFor(layout), appRef: { current: app }, topBarRef: { current: topBar }, bottomBarRef: { current: bottomBar },
      }));
      expect(app.style.getPropertyValue("--top-bar-h")).toBe("48px");
      expect(app.style.getPropertyValue("--bottom-bar-h")).toBe("96px");
    }
    expect(observe).toHaveBeenCalledWith(topBar);
    expect(observe).toHaveBeenCalledWith(bottomBar);
  });
});
