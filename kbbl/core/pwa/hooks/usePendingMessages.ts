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
  sid: string,
  events: EnvelopeEvent[],
  sessionStatus: SessionStatus | null,
): PendingMessagesState {
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const pendingIdSeq = useRef(0);
  const lastScannedIdxRef = useRef(0);

  // Navigating between sessions must not carry an in-flight bubble into the
  // new transcript — the new session's events have nothing to reconcile it
  // against and it would linger as a permanent "delivered" tag.
  useEffect(() => {
    setPendingMessages([]);
  }, [sid]);

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
    // [hang-debug] Trace bubble lifecycle so the "thinking indicator
    // stuck on" failure can be diagnosed from the browser console.
    console.debug(
      `[hang-debug] bubble.add sid=${sid} localId=${localId} bytes=${text.length} head=${JSON.stringify(text.slice(0, 60).replace(/\s+/g, " "))}`,
    );
    return localId;
  }, [sid]);

  const removePendingMessage = useCallback((localId: number) => {
    setPendingMessages((prev) => prev.filter((m) => m.localId !== localId));
    console.debug(`[hang-debug] bubble.remove sid=${sid} localId=${localId} reason=explicit`);
  }, [sid]);

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
        if (idx === -1) {
          if (prev.length > 0) {
            console.debug(
              `[hang-debug] bubble.reconcile sid=${sid} echo_bytes=${content.length} echo_head=${JSON.stringify(content.slice(0, 60).replace(/\s+/g, " "))} pending=${prev.length} match=none pending_heads=${JSON.stringify(prev.map((m) => m.text.slice(0, 60).replace(/\s+/g, " ")))}`,
            );
          }
          return prev;
        }
        console.debug(
          `[hang-debug] bubble.reconcile sid=${sid} localId=${prev[idx].localId} match=ok`,
        );
        const next = prev.slice();
        next.splice(idx, 1);
        return next;
      });
    }
    lastScannedIdxRef.current = events.length;
  }, [events, sid]);

  // [hang-debug] Every 15s, if a pending bubble has been alive >30s while
  // the session is live, dump its state. The "stuck on thinking" failure
  // means at least one bubble lingered far past any reasonable round-trip;
  // this captures it without changing behavior.
  useEffect(() => {
    if (pendingMessages.length === 0) return;
    if (sessionStatus !== "live") return;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const m of pendingMessages) {
        const ageMs = now - m.sentAt;
        if (ageMs > 30_000) {
          console.warn(
            `[hang-debug] bubble.stuck sid=${sid} localId=${m.localId} age_ms=${ageMs} head=${JSON.stringify(m.text.slice(0, 60).replace(/\s+/g, " "))}`,
          );
        }
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [pendingMessages, sessionStatus, sid]);

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
