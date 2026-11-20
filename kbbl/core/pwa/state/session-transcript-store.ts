import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { EMPTY_SESSION_LIVE_STATE } from "../../acp/transcript-model";
import type {
  SessionHistoryUnavailableReason, SessionLiveState, Status, StreamEpoch,
  TerminalSessionSummary, TranscriptItem, TranscriptItemId, UiOpenTurn,
} from "../types";

export interface SessionHistoryMeta {
  kind: "transcript" | "summary" | "unavailable";
  expired: boolean;
  summary: TerminalSessionSummary | null;
  unavailable_reason: SessionHistoryUnavailableReason | null;
}

export interface SessionConnection {
  status: Status;
  stream_error: string | null;
}

export interface SessionTranscriptState {
  stream_epoch: StreamEpoch | null;
  items_by_id: ReadonlyMap<TranscriptItemId, TranscriptItem>;
  ordered_ids: readonly TranscriptItemId[];
  has_earlier: boolean;
  is_truncated: boolean;
  is_loading_earlier: boolean;
  session_state: SessionLiveState;
  open_turns: readonly UiOpenTurn[];
  connection: SessionConnection;
  history: SessionHistoryMeta | null;
  transcript_version: number;
}

export const INITIAL_SESSION_TRANSCRIPT_STATE: SessionTranscriptState = {
  stream_epoch: null,
  items_by_id: new Map(),
  ordered_ids: [],
  has_earlier: false,
  is_truncated: false,
  is_loading_earlier: false,
  session_state: EMPTY_SESSION_LIVE_STATE,
  open_turns: [],
  connection: { status: "connecting", stream_error: null },
  history: null,
  transcript_version: 0,
};

const stores = new Map<string, StoreApi<SessionTranscriptState>>();

export function getSessionTranscriptStore(sid: string): StoreApi<SessionTranscriptState> {
  const existing = stores.get(sid);
  if (existing) return existing;
  const store = createStore(() => INITIAL_SESSION_TRANSCRIPT_STATE);
  stores.set(sid, store);
  return store;
}

export function releaseSessionTranscriptStore(sid: string): void {
  stores.delete(sid);
}

export function useSessionTranscript<T>(sid: string, selector: (state: SessionTranscriptState) => T): T {
  return useStore(getSessionTranscriptStore(sid), selector);
}

const orderedItemsCache = new WeakMap<
  SessionTranscriptState["ordered_ids"],
  WeakMap<SessionTranscriptState["items_by_id"], readonly TranscriptItem[]>
>();

export function selectOrderedItems({ ordered_ids, items_by_id }: SessionTranscriptState): readonly TranscriptItem[] {
  let byMap = orderedItemsCache.get(ordered_ids);
  if (!byMap) {
    byMap = new WeakMap();
    orderedItemsCache.set(ordered_ids, byMap);
  }
  const cached = byMap.get(items_by_id);
  if (cached) return cached;
  const items = ordered_ids.flatMap((id) => {
    const item = items_by_id.get(id);
    return item === undefined ? [] : [item];
  });
  byMap.set(items_by_id, items);
  return items;
}
