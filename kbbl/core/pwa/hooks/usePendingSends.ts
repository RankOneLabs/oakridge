import { useCallback, useEffect, useRef, useState } from "react";

import type { AcpUiEvent, PendingSend, SessionStatus } from "../types";

export interface PendingSendsState {
  pendingSends: PendingSend[];
  addPendingSend: (text: string) => number;
  removePendingSend: (localId: number) => void;
  lastPendingLocalId: number | null;
}

// Optimistic send bubbles: added before the POST round trip so the
// operator gets immediate feedback on a slow tailnet, reconciled away
// when the dispatched turn's user_message echo arrives on the stream
// (the controller projects every dispatched prompt as a user_message).
export function usePendingSends(
  sid: string,
  events: AcpUiEvent[],
  sessionStatus: SessionStatus | null,
): PendingSendsState {
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  const pendingIdSeq = useRef(0);
  const lastScannedIdxRef = useRef(0);

  // Navigating between sessions must not carry an in-flight bubble into
  // the new transcript.
  useEffect(() => {
    setPendingSends([]);
  }, [sid]);

  // Drop optimistic bubbles when the session leaves the live set so a
  // fence/close/failure doesn't pin a permanent bubble to a read-only
  // transcript.
  useEffect(() => {
    if (
      sessionStatus === "ended" ||
      sessionStatus === "fenced" ||
      sessionStatus === "failed"
    ) {
      setPendingSends([]);
    }
  }, [sessionStatus]);

  const addPendingSend = useCallback((text: string): number => {
    const localId = ++pendingIdSeq.current;
    setPendingSends((prev) => [...prev, { localId, text, sentAt: Date.now() }]);
    return localId;
  }, []);

  const removePendingSend = useCallback((localId: number) => {
    setPendingSends((prev) => prev.filter((m) => m.localId !== localId));
  }, []);

  // Reconcile echoes: a user_message whose text matches a pending bubble
  // retires it (first match wins).
  useEffect(() => {
    for (let i = lastScannedIdxRef.current; i < events.length; i++) {
      const event = events[i];
      if (event.kind !== "user_message") continue;
      const text = event.content.map((block) => block.text).join("");
      setPendingSends((prev) => {
        const idx = prev.findIndex((m) => m.text === text);
        if (idx === -1) return prev;
        const next = prev.slice();
        next.splice(idx, 1);
        return next;
      });
    }
    lastScannedIdxRef.current = events.length;
  }, [events]);

  // Reset the scan cursor when events is wiped (sid change / epoch reset)
  // so the freshly-arriving replay batch is scanned.
  useEffect(() => {
    if (events.length === 0) lastScannedIdxRef.current = 0;
  }, [events.length]);

  const lastPendingLocalId =
    pendingSends.length > 0
      ? pendingSends[pendingSends.length - 1].localId
      : null;

  return { pendingSends, addPendingSend, removePendingSend, lastPendingLocalId };
}
