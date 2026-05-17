import type React from "react";
import { useEffect, useLayoutEffect, useRef } from "react";

import type { SessionStatus } from "../types";

export interface AutoScrollAndLayoutInputs {
  sid: string;
  eventsLength: number;
  pendingLength: number;
  awaitingResult: boolean;
  sessionStatus: SessionStatus | null;
  appRef: React.RefObject<HTMLDivElement | null>;
  topBarRef: React.RefObject<HTMLElement | null>;
  bottomBarRef: React.RefObject<HTMLDivElement | null>;
}

export function useAutoScrollAndLayout({
  sid,
  eventsLength,
  pendingLength,
  awaitingResult,
  sessionStatus,
  appRef,
  topBarRef,
  bottomBarRef,
}: AutoScrollAndLayoutInputs): void {
  // Auto-scroll only when the user is already pinned near the bottom. If the
  // operator has scrolled up to read earlier output, new messages must not
  // yank them back down. A locally-sent message (pendingMessages increases)
  // is treated as an intent to follow along, so re-stick to bottom in that
  // case.
  const stickToBottomRef = useRef(true);
  const prevPendingLenRef = useRef(0);

  useEffect(() => {
    const STICK_THRESHOLD = 80;
    const onScroll = () => {
      const doc = document.documentElement;
      const distFromBottom =
        doc.scrollHeight - window.scrollY - window.innerHeight;
      stickToBottomRef.current = distFromBottom < STICK_THRESHOLD;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (pendingLength > prevPendingLenRef.current) {
      stickToBottomRef.current = true;
    }
    prevPendingLenRef.current = pendingLength;
    if (stickToBottomRef.current) {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    }
  }, [eventsLength, pendingLength, awaitingResult]);

  // Push the rendered top-bar / bottom-bar heights onto .app as CSS vars so
  // .events can pad first/last messages clear of the sticky bars. Both bars
  // resize at runtime — top bar grows when YOLO error chips appear, input
  // bar grows as the textarea expands and when the error row toggles — so
  // we re-measure via ResizeObserver. The bottom ref lands on whichever of
  // InputBox / EndedBanner is mounted; re-running on sessionStatus changes
  // re-binds the observer to the new node when the bar swaps.
  useLayoutEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const top = topBarRef.current;
    const bottom = bottomBarRef.current;
    const update = () => {
      if (top) app.style.setProperty("--top-bar-h", `${top.offsetHeight}px`);
      if (bottom)
        app.style.setProperty("--bottom-bar-h", `${bottom.offsetHeight}px`);
      else app.style.removeProperty("--bottom-bar-h");
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
