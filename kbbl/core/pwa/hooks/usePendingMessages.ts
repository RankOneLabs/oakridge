import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CCUserPayload,
  EnvelopeEvent,
  PendingMessage,
  SessionStatus,
} from "../types";
import { parseSlashCommand } from "../lib/events";

export interface PendingMessagesState {
  pendingMessages: PendingMessage[];
  addPendingMessage: (text: string) => number;
  removePendingMessage: (localId: number) => void;
  lastPendingLocalId: number | null;
}

export function usePendingMessages(
  events: EnvelopeEvent[],
  sessionStatus: SessionStatus | null,
): PendingMessagesState {
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const pendingIdSeq = useRef(0);
  const lastScannedIdxRef = useRef(0);

  // Drop optimistic bubbles when the session is no longer live so a
  // mid-turn Stop / subprocess crash doesn't leave a permanent
  // "delivered · awaiting reply" tag on the read-only transcript.
  useEffect(() => {
    if (sessionStatus !== "live") setPendingMessages([]);
  }, [sessionStatus]);

  const addPendingMessage = useCallback((text: string): number => {
    const localId = ++pendingIdSeq.current;
    setPendingMessages((prev) => [
      ...prev,
      { localId, text, sentAt: Date.now() },
    ]);
    return localId;
  }, []);

  const removePendingMessage = useCallback((localId: number) => {
    setPendingMessages((prev) => prev.filter((m) => m.localId !== localId));
  }, []);

  // Replayed user input echoed by CC (--replay-user-messages) — drop
  // the matching optimistic bubble so we don't show it twice. For
  // slash commands CC echoes the expanded <command-message> blob, not
  // the original `/name args` invocation, so reconstruct that form
  // and also match on it; otherwise the bubble lingers forever and
  // keeps the thinking indicator stuck on.
  useEffect(() => {
    for (let i = lastScannedIdxRef.current; i < events.length; i++) {
      const evt = events[i];
      if (evt.type !== "user") continue;
      const content = (evt.payload as CCUserPayload).message?.content;
      if (typeof content !== "string") continue;
      const slash = parseSlashCommand(content);
      // Normalize whitespace so `/foo  bar` (typed) still matches
      // `/foo bar` (reconstructed) — parseSlashCommand collapses
      // inner spacing on its way out.
      const normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();
      const reconstructed = slash
        ? slash.args
          ? `/${slash.name} ${slash.args}`
          : `/${slash.name}`
        : null;
      const normalizedReconstructed =
        reconstructed === null ? null : normalizeWs(reconstructed);
      setPendingMessages((prev) => {
        const idx = prev.findIndex(
          (m) =>
            m.text === content ||
            (normalizedReconstructed !== null &&
              normalizeWs(m.text) === normalizedReconstructed),
        );
        if (idx === -1) return prev;
        const next = prev.slice();
        next.splice(idx, 1);
        return next;
      });
    }
    lastScannedIdxRef.current = events.length;
  }, [events]);

  // Reset the scan cursor when events is wiped (sid change) so we don't
  // skip the freshly-arriving replay batch from the new session.
  useEffect(() => {
    if (events.length === 0) lastScannedIdxRef.current = 0;
  }, [events.length]);

  const lastPendingLocalId =
    pendingMessages.length > 0
      ? pendingMessages[pendingMessages.length - 1].localId
      : null;

  return {
    pendingMessages,
    addPendingMessage,
    removePendingMessage,
    lastPendingLocalId,
  };
}
