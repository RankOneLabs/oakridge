import type React from "react";
import { useEffect, useLayoutEffect, useRef } from "react";

import type { SessionStatus } from "../types";
import {
  DOCUMENT_SESSION_SURFACE_LAYOUT,
  STICK_TO_BOTTOM_THRESHOLD,
  nextScrollTarget,
  shouldStickToBottom,
  type ScrollMetrics,
  type SessionScrollHost,
  type SessionSurfaceLayout,
} from "../lib/session-surface";

export interface AutoScrollAndLayoutInputs {
  sid: string;
  eventsLength: number;
  pendingLength: number;
  awaitingResult: boolean;
  sessionStatus: SessionStatus | null;
  appRef: React.RefObject<HTMLDivElement | null>;
  topBarRef: React.RefObject<HTMLElement | null>;
  bottomBarRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Which host to scroll and where the bar anchors. Defaults to the
   * document/viewport layout, so the standalone session view gets today's
   * behaviour without passing anything.
   */
  layout?: SessionSurfaceLayout;
}

/** The scroll host's DOM surface, resolved once per effect run. */
interface ScrollHostTarget {
  readonly listenOn: EventTarget | null;
  readonly readMetrics: () => ScrollMetrics | null;
  readonly scrollTo: (top: number) => void;
}

// The one place that knows how each host reports geometry and takes a scroll.
// Everything above it deals in ScrollMetrics, which is why the stick decision
// itself is a pure transform and not tangled up with `window` vs an element.
const resolveScrollHost = (host: SessionScrollHost): ScrollHostTarget => {
  if (host.kind === "element") {
    const container = host.container.current;
    return {
      listenOn: container,
      readMetrics: () => container === null ? null : {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        threshold: STICK_TO_BOTTOM_THRESHOLD,
      },
      scrollTo: (top) => container?.scrollTo({ top }),
    };
  }
  return {
    listenOn: window,
    readMetrics: () => ({
      scrollHeight: document.documentElement.scrollHeight,
      scrollTop: window.scrollY,
      clientHeight: window.innerHeight,
      threshold: STICK_TO_BOTTOM_THRESHOLD,
    }),
    scrollTo: (top) => window.scrollTo({ top }),
  };
};

export function useAutoScrollAndLayout({
  sid,
  eventsLength,
  pendingLength,
  awaitingResult,
  sessionStatus,
  appRef,
  topBarRef,
  bottomBarRef,
  layout = DOCUMENT_SESSION_SURFACE_LAYOUT,
}: AutoScrollAndLayoutInputs): void {
  // Auto-scroll only when the user is already pinned near the bottom. If the
  // operator has scrolled up to read earlier output, new messages must not
  // yank them back down. A locally-sent message (pendingMessages increases)
  // is treated as an intent to follow along, so re-stick to bottom in that
  // case. Both rules live in lib/session-surface.ts; this hook only reads
  // metrics from whichever host it was given and applies the decision.
  const stickToBottomRef = useRef(true);
  const prevPendingLenRef = useRef(0);
  const scrollHost = layout.scrollHost;

  useEffect(() => {
    const host = resolveScrollHost(scrollHost);
    const target = host.listenOn;
    if (!target) return;
    const onScroll = () => {
      const metrics = host.readMetrics();
      if (metrics) stickToBottomRef.current = shouldStickToBottom(metrics);
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
    // The element host's container ref is stable for the surface's life; the
    // union's identity is what changes when a caller swaps layouts.
  }, [scrollHost]);

  useLayoutEffect(() => {
    const host = resolveScrollHost(scrollHost);
    const metrics = host.readMetrics();
    const decision = nextScrollTarget({
      scrollHeight: metrics?.scrollHeight ?? 0,
      wasStuckToBottom: stickToBottomRef.current,
      pendingLength,
      previousPendingLength: prevPendingLenRef.current,
    });
    stickToBottomRef.current = decision.isStuckToBottom;
    prevPendingLenRef.current = pendingLength;
    if (decision.scrollTo !== null) host.scrollTo(decision.scrollTo);
  }, [eventsLength, pendingLength, awaitingResult, scrollHost]);

  // Push the rendered top-bar / bottom-bar heights onto the surface root as
  // CSS vars so .events can pad first/last messages clear of the sticky bars.
  // Both bars resize at runtime — top bar grows when YOLO error chips appear,
  // input bar grows as the textarea expands and when the error row toggles —
  // so we re-measure via ResizeObserver. The bottom ref lands on whichever of
  // InputBox / EndedBanner is mounted; re-running on sessionStatus changes
  // re-binds the observer to the new node when the bar swaps.
  //
  // The vars go on `appRef` in both layouts: it is the surface root, which is
  // the viewport-sized `.app` standalone and the pane's own root embedded. The
  // measurement is what keeps the transcript's bottom clearance in step with a
  // growing textarea, and it is anchoring — not measurement — that varies, so
  // this runs identically for both hosts.
  useLayoutEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const top = topBarRef.current;
    const bottom = bottomBarRef.current;
    const update = () => {
      if (top) app.style.setProperty("--top-bar-h", `${top.offsetHeight}px`);
      if (bottom && bottom.offsetHeight > 0) {
        app.style.setProperty("--bottom-bar-h", `${bottom.offsetHeight}px`);
      } else {
        app.style.removeProperty("--bottom-bar-h");
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    if (top) ro.observe(top);
    if (bottom) ro.observe(bottom);
    return () => ro.disconnect();
  }, [sessionStatus]);

  useEffect(() => {
    stickToBottomRef.current = true;
    prevPendingLenRef.current = 0;
  }, [sid]);
}
