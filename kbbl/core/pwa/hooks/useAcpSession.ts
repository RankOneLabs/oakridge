import { useEffect, useState } from "react";

import { LiveSubscription } from "../lib/live-stream";
import { applySessionFrame, EMPTY_SESSION_STREAM_STATE, type SessionStreamState } from "../lib/session-frames";
import type { SessionWireFrame, Status } from "../types";

export interface AcpSessionStream {
  items: SessionStreamState["items"];
  sessionState: SessionStreamState["session_state"];
  hasEarlier: boolean;
  isTruncated: boolean;
  streamStatus: Status;
  expired: boolean;
  summary: SessionStreamState["summary"];
  unavailableReason: SessionStreamState["unavailable_reason"];
  streamError: string | null;
  openTurns: SessionStreamState["open_turns"];
  historyLoaded: boolean;
  transcriptVersion: number;
}

interface SessionStreamView {
  state: SessionStreamState;
  historyLoaded: boolean;
  transcriptVersion: number;
}

const EMPTY_VIEW: SessionStreamView = {
  state: EMPTY_SESSION_STREAM_STATE,
  historyLoaded: false,
  transcriptVersion: 0,
};

const LIVE_FRAME_KINDS = ["item", "item_text", "session_state", "turn_state", "stream_error"] as const;

function parseSessionFrame(event: MessageEvent<string>): SessionWireFrame | null {
  try {
    const payload: SessionWireFrame | null = JSON.parse(event.data);
    if (event.type === "stream_error") {
      // The shared live relay also emits errors without the session frame discriminator.
      if (!payload || !("error" in payload) || typeof payload.error !== "string") return null;
      return { kind: "stream_error", error: payload.error, code: typeof payload.code === "string" ? payload.code : "stream_error" };
    }
    if (!payload?.kind || payload.kind === "stream_error") return null;
    return payload.kind === event.type ? payload : null;
  } catch {
    return null;
  }
}

export function useAcpSession(sid: string): AcpSessionStream {
  const [view, setView] = useState(EMPTY_VIEW);
  const [streamStatus, setStreamStatus] = useState<Status>("connecting");

  useEffect(() => {
    setView(EMPTY_VIEW);
    let current: LiveSubscription | null = null;
    let stopped = false;
    let pending: SessionWireFrame[] = [];
    let pendingFrame: number | null = null;

    const clearPending = () => {
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
      pending = [];
    };
    const flushPending = () => {
      const batch = pending;
      pending = [];
      pendingFrame = null;
      setView((previous) => ({
        ...previous,
        state: batch.reduce(applySessionFrame, previous.state),
        transcriptVersion: previous.transcriptVersion + 1,
      }));
    };

    const connect = () => {
      if (stopped) return;
      current?.close();
      setStreamStatus("connecting");
      const es = new LiveSubscription(`/sessions/${encodeURIComponent(sid)}/stream`);
      current = es;
      es.onopen = () => setStreamStatus("connected");
      es.onerror = () => setStreamStatus("disconnected");

      const receive = (event: MessageEvent<string>) => {
        const frame = parseSessionFrame(event);
        if (!frame) return;
        if (frame.kind === "epoch") {
          clearPending();
          setView((previous) => ({
            state: applySessionFrame(previous.state, frame),
            historyLoaded: true,
            transcriptVersion: previous.transcriptVersion + 1,
          }));
        } else {
          pending.push(frame);
          if (pendingFrame === null) pendingFrame = requestAnimationFrame(flushPending);
        }
      };

      es.addEventListener("epoch", receive);
      for (const kind of LIVE_FRAME_KINDS) es.addEventListener(kind, receive);
    };

    const reviveIfStale = () => {
      if (document.visibilityState !== "visible") return;
      if (!current || current.readyState === EventSource.CLOSED) connect();
    };

    connect();
    document.addEventListener("visibilitychange", reviveIfStale);
    window.addEventListener("focus", reviveIfStale);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", reviveIfStale);
      window.removeEventListener("focus", reviveIfStale);
      clearPending();
      current?.close();
    };
  }, [sid]);

  const { state, historyLoaded, transcriptVersion } = view;
  return {
    items: state.items,
    sessionState: state.session_state,
    hasEarlier: state.has_earlier,
    isTruncated: state.is_truncated,
    streamStatus,
    expired: state.expired,
    summary: state.summary,
    unavailableReason: state.unavailable_reason,
    streamError: state.stream_error,
    openTurns: state.open_turns,
    historyLoaded,
    transcriptVersion,
  };
}
