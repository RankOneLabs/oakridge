import { describe, expect, it } from "vitest";

import {
  DOCUMENT_SESSION_SURFACE_LAYOUT,
  STICK_TO_BOTTOM_THRESHOLD,
  nextScrollTarget,
  shouldStickToBottom,
} from "./session-surface";

// A phone-sized document and a pane-sized element, so the threshold is shown
// to be about distance from the bottom rather than about the host's size.
const documentMetrics = (scrollTop: number) => ({
  scrollHeight: 8000, scrollTop, clientHeight: 800, threshold: STICK_TO_BOTTOM_THRESHOLD,
});
const elementMetrics = (scrollTop: number) => ({
  scrollHeight: 1200, scrollTop, clientHeight: 400, threshold: STICK_TO_BOTTOM_THRESHOLD,
});

describe("shouldStickToBottom", () => {
  it("sticks when the document is pinned to the bottom", () => {
    expect(shouldStickToBottom(documentMetrics(7200))).toBe(true);
  });

  it("releases when the document is scrolled up beyond the threshold", () => {
    expect(shouldStickToBottom(documentMetrics(7000))).toBe(false);
  });

  /** Exactly at the threshold counts as scrolled away — the comparison is strict. */
  it("releases when the document sits exactly at the threshold", () => {
    expect(shouldStickToBottom(documentMetrics(8000 - 800 - STICK_TO_BOTTOM_THRESHOLD))).toBe(false);
  });

  it("sticks when the element is pinned to the bottom", () => {
    expect(shouldStickToBottom(elementMetrics(800))).toBe(true);
  });

  it("releases when the element is scrolled up beyond the threshold", () => {
    expect(shouldStickToBottom(elementMetrics(600))).toBe(false);
  });

  it("releases when the element sits exactly at the threshold", () => {
    expect(shouldStickToBottom(elementMetrics(1200 - 400 - STICK_TO_BOTTOM_THRESHOLD))).toBe(false);
  });

  it("sticks when the content is shorter than the host", () => {
    expect(shouldStickToBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 800, threshold: STICK_TO_BOTTOM_THRESHOLD })).toBe(true);
  });
});

describe("nextScrollTarget", () => {
  it("follows the output down while the reader is pinned", () => {
    expect(nextScrollTarget({ scrollHeight: 8000, wasStuckToBottom: true, pendingLength: 0, previousPendingLength: 0 }))
      .toEqual({ isStuckToBottom: true, scrollTo: 8000 });
  });

  it("leaves a reader who scrolled up where they are", () => {
    expect(nextScrollTarget({ scrollHeight: 8000, wasStuckToBottom: false, pendingLength: 0, previousPendingLength: 0 }))
      .toEqual({ isStuckToBottom: false, scrollTo: null });
  });

  /** Sending is the one action that says "I am here now". */
  it("re-sticks when the reader sends a message after scrolling up", () => {
    expect(nextScrollTarget({ scrollHeight: 8000, wasStuckToBottom: false, pendingLength: 1, previousPendingLength: 0 }))
      .toEqual({ isStuckToBottom: true, scrollTo: 8000 });
  });

  it("does not re-stick when a pending message is merely resolved away", () => {
    expect(nextScrollTarget({ scrollHeight: 8000, wasStuckToBottom: false, pendingLength: 0, previousPendingLength: 1 }))
      .toEqual({ isStuckToBottom: false, scrollTo: null });
  });
});

describe("DOCUMENT_SESSION_SURFACE_LAYOUT", () => {
  /** The standalone view's behaviour is the default, so it needs no caller changes. */
  it("is the document host anchored to the viewport", () => {
    expect(DOCUMENT_SESSION_SURFACE_LAYOUT).toEqual({ scrollHost: { kind: "document" }, barAnchor: "viewport" });
  });
});
