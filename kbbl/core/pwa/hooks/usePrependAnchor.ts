import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { selectSessionTranscriptItems } from "../lib/session-items";
import { computeAnchoredScrollTop } from "../lib/thread-scroll";
import type { LoadEarlierResult } from "../lib/session-transcript-connection";
import { getSessionTranscriptStore, selectOrderedItems, useSessionTranscript } from "../state/session-transcript-store";
import type { StreamEpoch } from "../types";

interface PrependAnchor {
  row: HTMLElement;
  offset: number;
  epoch: StreamEpoch | null;
}

interface PrependAnchorOptions {
  sid: string;
  viewportRef: RefObject<HTMLDivElement | null>;
  renderedMessages: readonly { id: string }[];
  loadEarlier: () => Promise<LoadEarlierResult>;
}

export function usePrependAnchor({ sid, viewportRef, renderedMessages, loadEarlier }: PrependAnchorOptions) {
  const [anchor, setAnchor] = useState<PrependAnchor | null>(null);
  const [failure, setFailure] = useState<{ message: string; epoch: StreamEpoch | null } | null>(null);
  const isRequestInFlight = useRef(false);
  const store = getSessionTranscriptStore(sid);
  const streamEpoch = useSessionTranscript(sid, (state) => state.stream_epoch);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !anchor) return;
    const state = store.getState();
    if (state.stream_epoch !== anchor.epoch || !viewport.contains(anchor.row)) {
      setAnchor(null);
      return;
    }
    // The runtime publishes its messages separately from the transcript store.
    // Wait until the DOM includes the loaded page, even if the first ID stayed the same.
    const items = selectSessionTranscriptItems(selectOrderedItems(state), state.session_state);
    if (items.length !== renderedMessages.length || items.some((item, index) => item.id !== renderedMessages[index]?.id)) return;

    viewport.scrollTop = computeAnchoredScrollTop(anchor.row.offsetTop, anchor.offset);
    setAnchor(null);
  }, [anchor, renderedMessages, store, streamEpoch, viewportRef]);

  const onLoadEarlier = useCallback(async () => {
    if (isRequestInFlight.current) return;
    isRequestInFlight.current = true;
    const epoch = store.getState().stream_epoch;
    let recorded: PrependAnchor | null = null;
    const viewport = viewportRef.current;
    if (viewport) {
      const bounds = viewport.getBoundingClientRect();
      const row = Array.from(viewport.querySelectorAll<HTMLElement>("[data-item-id]")).find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      if (row) recorded = { row, offset: row.offsetTop - viewport.scrollTop, epoch };
    }

    try {
      const result = await loadEarlier();
      setFailure(result.ok ? null : { message: result.error, epoch });
      if (result.ok && result.value === "loaded") setAnchor(recorded);
    } finally {
      isRequestInFlight.current = false;
    }
  }, [viewportRef, loadEarlier, store]);

  return {
    onLoadEarlier,
    loadError: failure?.epoch === streamEpoch ? failure.message : null,
  };
}
