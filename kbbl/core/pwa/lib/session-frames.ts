import {
  INITIAL_SESSION_TRANSCRIPT_STATE,
  type SessionTranscriptState,
} from "../state/session-transcript-store";
import type { SessionEpochFrame, SessionWireFrame, TranscriptItem, TranscriptItemId, TurnKey } from "../types";

export function applyEpochFrame(
  frame: SessionEpochFrame,
  previous = INITIAL_SESSION_TRANSCRIPT_STATE,
): SessionTranscriptState {
  return {
    ...INITIAL_SESSION_TRANSCRIPT_STATE,
    stream_epoch: frame.stream_epoch,
    items_by_id: new Map(frame.items.map((item) => [item.id, item])),
    ordered_ids: frame.items.map((item) => item.id),
    has_earlier: frame.has_earlier,
    is_truncated: frame.is_truncated,
    session_state: frame.session_state,
    open_turns: frame.open_turns,
    // A reconnect in the same epoch can race an outstanding input receipt.
    terminal_turn_keys: frame.stream_epoch !== null && frame.stream_epoch === previous.stream_epoch
      ? previous.terminal_turn_keys
      : INITIAL_SESSION_TRANSCRIPT_STATE.terminal_turn_keys,
    connection: { status: previous.connection.status, stream_error: null },
    history: {
      kind: frame.history_kind,
      expired: frame.expired,
      summary: frame.summary,
      unavailable_reason: frame.unavailable_reason ?? null,
    },
    transcript_version: previous.transcript_version + 1,
  };
}

export function applyIncrementalFrames(
  state: SessionTranscriptState,
  frames: readonly SessionWireFrame[],
): SessionTranscriptState {
  let next = state;
  let items: Map<TranscriptItemId, TranscriptItem> | null = null;
  let ordered: TranscriptItemId[] | null = null;
  let terminalTurnKeys: Set<TurnKey> | null = null;
  for (const frame of frames) {
    switch (frame.kind) {
      case "epoch":
        break;
      case "item": {
        items ??= new Map(state.items_by_id);
        const { item } = frame;
        if (!items.has(item.id)) {
          ordered ??= [...state.ordered_ids];
          // Live inserts usually append. Only search when the new item belongs earlier.
          const last = ordered.at(-1);
          const updatedItems = items;
          const lastItem = last === undefined ? undefined : updatedItems.get(last);
          const index = lastItem && lastItem.seq > item.seq
            ? ordered.findIndex((id) => {
                const entry = updatedItems.get(id);
                return entry !== undefined && entry.seq > item.seq;
              })
            : -1;
          ordered.splice(index === -1 ? ordered.length : index, 0, item.id);
        }
        items.set(item.id, item);
        break;
      }
      case "item_text": {
        const item = (items ?? state.items_by_id).get(frame.id);
        if (item?.kind !== "user_message" && item?.kind !== "agent_message" && item?.kind !== "thought") break;
        const text = item.text + frame.delta;
        items ??= new Map(state.items_by_id);
        items.set(item.id, item.kind === "user_message"
          ? { ...item, text }
          : { ...item, text, is_streaming: frame.is_streaming });
        break;
      }
      case "session_state":
        next = { ...next, session_state: frame.state };
        break;
      case "turn_accepted":
        if (!(terminalTurnKeys ?? state.terminal_turn_keys).has(frame.turn.turnKey) &&
            !next.open_turns.some((turn) => turn.turnKey === frame.turn.turnKey)) {
          next = { ...next, open_turns: [...next.open_turns, frame.turn] };
        }
        break;
      case "turn_state":
        if (frame.state !== "prompting" && !(terminalTurnKeys ?? state.terminal_turn_keys).has(frame.turn_key)) {
          terminalTurnKeys ??= new Set(state.terminal_turn_keys);
          terminalTurnKeys.add(frame.turn_key);
        }
        next = {
          ...next,
          open_turns: frame.state === "prompting"
            ? next.open_turns.map((turn) => turn.turnKey === frame.turn_key ? { ...turn, status: "prompting" } : turn)
            : next.open_turns.filter((turn) => turn.turnKey !== frame.turn_key),
        };
        break;
      case "stream_error":
        next = { ...next, connection: { ...next.connection, stream_error: frame.error } };
        break;
    }
  }
  if (next === state && items === null) return state;
  return {
    ...next,
    items_by_id: items ?? state.items_by_id,
    ordered_ids: ordered ?? state.ordered_ids,
    terminal_turn_keys: terminalTurnKeys ?? state.terminal_turn_keys,
    transcript_version: state.transcript_version + 1,
  };
}

export function prependPage(
  state: SessionTranscriptState,
  page_items: readonly TranscriptItem[],
): SessionTranscriptState {
  const items = new Map(state.items_by_id);
  for (const item of page_items) {
    if (!items.has(item.id)) items.set(item.id, item);
  }
  if (items.size === state.items_by_id.size) return state;
  return {
    ...state,
    items_by_id: items,
    ordered_ids: [...items.values()].sort((left, right) => left.seq - right.seq).map(({ id }) => id),
    transcript_version: state.transcript_version + 1,
  };
}
