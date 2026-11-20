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

export interface SessionTurnAcceptedFrame {
  kind: "turn_accepted";
  turn: UiOpenTurn;
}

export interface SessionStreamErrorFrame {
  kind: "stream_error";
  error: string;
  code: string;
}

export type SessionWireFrame = SessionEpochFrame | SessionItemFrame | SessionItemTextFrame |
  { kind: "history_truncated" } | SessionStateFrame | SessionTurnAcceptedFrame | SessionTurnFrame | SessionStreamErrorFrame;

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
        return [{ kind: "history_truncated" }];
    }
  });
}

export function createSessionFrameEncoder(epoch: SessionEpochFrame) {
  let hasReportedTruncation = epoch.is_truncated;
  const sentItems = new Set(epoch.items.map((item) => item.id));
  return (frames: readonly StreamFrame[], items: readonly TranscriptItem[]): SessionWireFrame[] => {
    const seeded: StreamFrame[] = [];
    for (const frame of frames) {
      if (frame.kind === "items_evicted") {
        for (const id of frame.item_ids) sentItems.delete(id);
        if (hasReportedTruncation) continue;
        hasReportedTruncation = true;
      } else if (frame.kind === "item_upsert") {
        sentItems.add(frame.item.id);
      } else if (frame.kind === "item_text" && !sentItems.has(frame.item_id)) {
        // A reopened run can have a sequence older than this connection's epoch window.
        // A full upsert later in this emission already includes the delta.
        if (frames.some((next) => next.kind === "item_upsert" && next.item.id === frame.item_id)) continue;
        const item = items[lowerBoundItemSeq(items, frame.seq)];
        if (item?.id === frame.item_id) {
          sentItems.add(item.id);
          seeded.push({ kind: "item_upsert", item });
        }
        continue;
      }
      seeded.push(frame);
    }
    return toWireFrames(seeded, items);
  };
}

export function streamErrorFrame(error: AcpError): SessionStreamErrorFrame {
  return { kind: "stream_error", error: error.detail, code: error.code };
}
