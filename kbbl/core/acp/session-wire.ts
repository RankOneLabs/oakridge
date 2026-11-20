import { lowerBoundItemSeq } from "./transcript-page";
import { EMPTY_SESSION_LIVE_STATE, type StreamEpoch, type StreamFrame, type TranscriptItem, type TranscriptItemId, type SessionLiveState, type TurnFrameState } from "./transcript-model";
import type { AcpError, SessionHistoryUnavailableReason, TerminalSessionSummary, TurnKey, UiOpenTurn, UiSessionHistory } from "./types";

export interface SessionEpochFrame {
  kind: "epoch";
  stream_epoch: StreamEpoch | null;
  history_kind: UiSessionHistory["kind"];
  expired: boolean;
  summary: TerminalSessionSummary | null;
  unavailable_reason?: SessionHistoryUnavailableReason;
  open_turns: readonly UiOpenTurn[];
  session_state: SessionLiveState;
  items: readonly TranscriptItem[];
  has_earlier: boolean;
  is_truncated: boolean;
}

export interface SessionItemFrame {
  kind: "item";
  item: TranscriptItem;
}

export interface SessionItemTextFrame {
  kind: "item_text";
  id: TranscriptItemId;
  delta: string;
  is_streaming: boolean;
}

export interface SessionStateFrame {
  kind: "session_state";
  state: SessionLiveState;
}

export interface SessionTurnFrame {
  kind: "turn_state";
  turn_key: TurnKey;
  state: TurnFrameState;
  stop_reason: string | null;
  detail: string | null;
}

export interface SessionStreamErrorFrame {
  kind: "stream_error";
  error: string;
  code: string;
}

export type SessionWireFrame = SessionEpochFrame | SessionItemFrame | SessionItemTextFrame |
  SessionStateFrame | SessionTurnFrame | SessionStreamErrorFrame;

interface EpochFrameInput {
  history: UiSessionHistory;
  stream_epoch: StreamEpoch | null;
  initial_item_window: number;
}

export function buildEpochFrame({ history, stream_epoch, initial_item_window }: EpochFrameInput): SessionEpochFrame {
  const transcript = history.transcript;
  return {
    kind: "epoch",
    stream_epoch: transcript?.stream_epoch ?? stream_epoch,
    history_kind: history.kind,
    expired: history.expired,
    summary: history.summary,
    ...(history.kind === "unavailable" ? { unavailable_reason: history.reason } : {}),
    open_turns: history.openTurns,
    session_state: transcript?.live_state ?? EMPTY_SESSION_LIVE_STATE,
    items: transcript ? transcript.items.slice(Math.max(0, transcript.items.length - initial_item_window)) : [],
    has_earlier: (transcript?.items.length ?? 0) > initial_item_window,
    is_truncated: transcript?.is_truncated ?? false,
  };
}

export function toWireFrames(frames: readonly StreamFrame[], items: readonly TranscriptItem[]): SessionWireFrame[] {
  return frames.flatMap((frame): SessionWireFrame[] => {
    switch (frame.kind) {
      case "item_upsert":
        return [{ kind: "item", item: frame.item }];
      case "item_text": {
        const item = items[lowerBoundItemSeq(items, frame.seq)];
        const is_streaming = item?.seq === frame.seq &&
          (item.kind === "agent_message" || item.kind === "thought") && item.is_streaming;
        return [{ kind: "item_text", id: frame.item_id, delta: frame.delta, is_streaming }];
      }
      case "session_state":
        return [{ kind: "session_state", state: frame.state }];
      case "turn_state":
        return [{ kind: "turn_state", turn_key: frame.turn_key, state: frame.state,
          stop_reason: frame.stop_reason, detail: frame.detail }];
      case "items_evicted":
        return [];
    }
  });
}

export function streamErrorFrame(error: AcpError): SessionStreamErrorFrame {
  return { kind: "stream_error", error: error.detail, code: error.code };
}
