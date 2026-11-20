import { EMPTY_SESSION_LIVE_STATE } from "../../acp/transcript-model";
import type { SessionEpochFrame, SessionHistoryUnavailableReason, SessionWireFrame, TranscriptItem } from "../types";

export interface SessionStreamState extends Omit<SessionEpochFrame, "kind" | "items" | "unavailable_reason"> {
  items: TranscriptItem[];
  unavailable_reason: SessionHistoryUnavailableReason | null;
  stream_error: string | null;
}

export const EMPTY_SESSION_STREAM_STATE: SessionStreamState = {
  stream_epoch: null,
  items: [],
  session_state: EMPTY_SESSION_LIVE_STATE,
  has_earlier: false,
  is_truncated: false,
  history_kind: "unavailable",
  expired: false,
  summary: null,
  unavailable_reason: null,
  open_turns: [],
  stream_error: null,
};

export function applySessionFrame(state: SessionStreamState, frame: SessionWireFrame): SessionStreamState {
  switch (frame.kind) {
    case "epoch": {
      const { kind, ...epoch } = frame;
      return { ...epoch, items: [...epoch.items], unavailable_reason: epoch.unavailable_reason ?? null, stream_error: null };
    }
    case "item": {
      const items = [...state.items];
      const existing = items.findIndex((item) => item.id === frame.item.id);
      if (existing !== -1) {
        items[existing] = frame.item;
      } else {
        const next = items.findIndex((item) => item.seq > frame.item.seq);
        items.splice(next === -1 ? items.length : next, 0, frame.item);
      }
      return { ...state, items };
    }
    case "item_text": {
      const index = state.items.findIndex((item) => item.id === frame.id);
      const item = state.items[index];
      if (item?.kind !== "user_message" && item?.kind !== "agent_message" && item?.kind !== "thought") return state;
      const items = [...state.items];
      const text = item.text + frame.delta;
      items[index] = item.kind === "user_message"
        ? { ...item, text }
        : { ...item, text, is_streaming: frame.is_streaming };
      return { ...state, items };
    }
    case "session_state":
      return { ...state, session_state: frame.state };
    case "turn_state":
      return {
        ...state,
        open_turns: frame.state === "prompting"
          ? state.open_turns.map((turn) => turn.turnKey === frame.turn_key ? { ...turn, status: "prompting" } : turn)
          : state.open_turns.filter((turn) => turn.turnKey !== frame.turn_key),
      };
    case "stream_error":
      return { ...state, stream_error: frame.error };
  }
}
