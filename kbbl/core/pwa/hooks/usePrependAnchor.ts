import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { computeAnchoredScrollTop } from "../lib/thread-scroll";
import type { LoadEarlierResult } from "../lib/session-transcript-connection";

interface PrependAnchor {
  row: HTMLElement;
  offset: number;
}

export function usePrependAnchor(
  viewportRef: RefObject<HTMLDivElement | null>,
  firstId: string | undefined,
  loadEarlier: () => Promise<LoadEarlierResult>,
) {
  const anchor = useRef<PrependAnchor | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const recorded = anchor.current;
    if (!viewport || !recorded) return;
    // Message wrappers are keyed by item ID, so the same DOM row survives a prepend.
    if (viewport.contains(recorded.row)) {
      viewport.scrollTop = computeAnchoredScrollTop(recorded.row.offsetTop, recorded.offset);
    }
    anchor.current = null;
  }, [viewportRef, firstId]);

  return useCallback(async () => {
    const viewport = viewportRef.current;
    if (viewport) {
      const bounds = viewport.getBoundingClientRect();
      const row = Array.from(viewport.querySelectorAll<HTMLElement>("[data-item-id]")).find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      anchor.current = row ? { row, offset: row.offsetTop - viewport.scrollTop } : null;
    }

    const result = await loadEarlier();
    if (!result.ok || result.value !== "loaded") anchor.current = null;
  }, [viewportRef, loadEarlier]);
}
