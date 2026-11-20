import { useEffect, useState } from "react";

import { acquireSessionTranscript, type SessionTranscriptHandle } from "../lib/session-transcript-connection";
import { selectOrderedItems, useSessionTranscript } from "../state/session-transcript-store";

interface AcquiredSession {
  sid: string;
  handle: SessionTranscriptHandle;
}

export function useAcpSession(sid: string) {
  const [acquired, setAcquired] = useState<AcquiredSession | null>(null);

  useEffect(() => {
    const handle = acquireSessionTranscript(sid);
    // Rebind the store selector after effect remounts that replace the last reader.
    setAcquired({ sid, handle });
    return handle.release;
  }, [sid]);

  const history = useSessionTranscript(sid, (state) => state.history);
  return {
    items: useSessionTranscript(sid, selectOrderedItems),
    sessionState: useSessionTranscript(sid, (state) => state.session_state),
    hasEarlier: useSessionTranscript(sid, (state) => state.has_earlier),
    isTruncated: useSessionTranscript(sid, (state) => state.is_truncated),
    isLoadingEarlier: useSessionTranscript(sid, (state) => state.is_loading_earlier),
    streamStatus: useSessionTranscript(sid, (state) => state.connection.status),
    streamError: useSessionTranscript(sid, (state) => state.connection.stream_error),
    expired: history?.expired ?? false,
    summary: history?.summary ?? null,
    unavailableReason: history?.unavailable_reason ?? null,
    openTurns: useSessionTranscript(sid, (state) => state.open_turns),
    terminalTurnKeys: useSessionTranscript(sid, (state) => state.terminal_turn_keys),
    historyLoaded: history !== null,
    transcriptVersion: useSessionTranscript(sid, (state) => state.transcript_version),
    loadEarlier: acquired?.sid === sid ? acquired.handle.loadEarlier : loadEarlierBeforeAcquire,
  };
}

async function loadEarlierBeforeAcquire() {
  return { ok: true, value: "noop" } as const;
}
