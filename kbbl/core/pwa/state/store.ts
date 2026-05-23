import { create } from "zustand";

import type { Sid, TaskId } from "../lib/ids";
import type {
  CompactSuggestion,
  InboxDelta,
  SessionSnapshot,
  Status,
} from "../types";

export interface AppState {
  sessions: Map<Sid, SessionSnapshot>;
  // Sids the server currently has in memory (live or ended-but-lingering).
  // Differs from `sessions.keys()` because archived-only entries from the
  // /sessions?include=archived seed aren't in memory. SessionView uses this
  // to decide whether to open /:sid/stream (in-memory) or fall back to the
  // one-shot /:sid/events (archived on disk).
  inMemorySids: Set<Sid>;
  inboxStatus: Status;
  compactSuggestions: Map<Sid, CompactSuggestion>;
  currentSid: Sid | null;
  currentTaskId: TaskId | null;
  removedSids: Set<Sid>;

  hydrateSession: (snapshot: SessionSnapshot) => void;
  seedSessions: (snapshots: SessionSnapshot[]) => void;
  applySnapshot: (snapshots: SessionSnapshot[]) => void;
  applyInboxDelta: (delta: InboxDelta) => void;
  setInboxStatus: (status: Status) => void;
  setCurrentSid: (sid: Sid | null) => void;
  setCurrentTaskId: (taskId: TaskId | null) => void;
  clearCompactSuggestion: (sid: Sid) => void;
}

export const useStore = create<AppState>()((set) => ({
  sessions: new Map(),
  inMemorySids: new Set(),
  inboxStatus: "connecting",
  compactSuggestions: new Map(),
  currentSid: null,
  currentTaskId: null,
  removedSids: new Set(),

  hydrateSession: (snapshot) =>
    set((state) => {
      const sid = snapshot.sid as Sid;
      const sessions = new Map(state.sessions);
      sessions.set(sid, snapshot);
      const removedSids = state.removedSids.has(sid)
        ? (() => {
            const next = new Set(state.removedSids);
            next.delete(sid);
            return next;
          })()
        : state.removedSids;
      const inMemorySids = state.inMemorySids.has(sid)
        ? state.inMemorySids
        : new Set(state.inMemorySids).add(sid);
      return { sessions, inMemorySids, removedSids };
    }),

  // Seed from /sessions?include=archived: archived-only entries are folded in
  // without overwriting fresher in-memory entries. Non-ended sids are marked
  // as in-memory so SessionView picks /:sid/stream before the SSE attaches.
  seedSessions: (snapshots) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      const inMemorySids = new Set(state.inMemorySids);
      for (const s of snapshots) {
        const sid = s.sid as Sid;
        if (state.removedSids.has(sid)) continue;
        if (!sessions.has(sid)) sessions.set(sid, s);
        if (s.status !== "ended") inMemorySids.add(sid);
      }
      return { sessions, inMemorySids };
    }),

  // SSE snapshot event: server has authoritative in-memory list — overwrite
  // entries and replace inMemorySids wholesale.
  applySnapshot: (snapshots) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      const removedSids = new Set(state.removedSids);
      for (const s of snapshots) {
        const sid = s.sid as Sid;
        sessions.set(sid, s);
        removedSids.delete(sid);
      }
      const inMemorySids = new Set<Sid>();
      for (const s of snapshots) inMemorySids.add(s.sid as Sid);
      return { sessions, inMemorySids, removedSids };
    }),

  applyInboxDelta: (delta) =>
    set((state) => applyDelta(state, delta)),

  setInboxStatus: (inboxStatus) => set({ inboxStatus }),
  setCurrentSid: (currentSid) => set({ currentSid }),
  setCurrentTaskId: (currentTaskId) => set({ currentTaskId }),

  clearCompactSuggestion: (sid) =>
    set((state) => {
      if (!state.compactSuggestions.has(sid)) return state;
      const compactSuggestions = new Map(state.compactSuggestions);
      compactSuggestions.delete(sid);
      return { compactSuggestions };
    }),
}));

function applyDelta(state: AppState, delta: InboxDelta): Partial<AppState> {
  switch (delta.type) {
    case "session_created": {
      const sid = delta.session.sid as Sid;
      const sessions = new Map(state.sessions);
      sessions.set(sid, delta.session);
      const removedSids = state.removedSids.has(sid)
        ? (() => {
            const next = new Set(state.removedSids);
            next.delete(sid);
            return next;
          })()
        : state.removedSids;
      const inMemorySids = state.inMemorySids.has(sid)
        ? state.inMemorySids
        : new Set(state.inMemorySids).add(sid);
      return { sessions, inMemorySids, removedSids };
    }
    case "session_ended": {
      const sid = delta.sid as Sid;
      const prev = state.sessions.get(sid);
      if (!prev) return mergeCompactClear(state, sid);
      const sessions = new Map(state.sessions);
      sessions.set(sid, { ...prev, status: "ended", pendingCount: 0 });
      return {
        sessions,
        ...mergeCompactClear(state, sid),
      };
    }
    case "session_removed": {
      const sid = delta.sid as Sid;
      const sessions = new Map(state.sessions);
      sessions.delete(sid);
      const inMemorySids = state.inMemorySids.has(sid)
        ? (() => {
            const next = new Set(state.inMemorySids);
            next.delete(sid);
            return next;
          })()
        : state.inMemorySids;
      const removedSids = new Set(state.removedSids);
      removedSids.add(sid);
      return { sessions, inMemorySids, removedSids, ...mergeCompactClear(state, sid) };
    }
    case "session_compacted": {
      const sid = delta.sid as Sid;
      const prev = state.sessions.get(sid);
      // Ordering: finalize() emits status_changed("ended"), then onEnded
      // broadcasts session_ended, then abort() resolves and session_compacted
      // is broadcast. By the time this case runs, status is already "ended".
      // Patch in endReason + successorSid so CompactedBanner has the data it
      // needs without a snapshot refetch. If the predecessor isn't in the map
      // (rare race during initial seed), the next snapshot refresh carries
      // the same fields from disk.
      if (!prev) return mergeCompactClear(state, sid);
      const sessions = new Map(state.sessions);
      sessions.set(sid, {
        ...prev,
        endReason: "compacted",
        successorSid: delta.successor_sid,
      });
      return { sessions, ...mergeCompactClear(state, sid) };
    }
    case "status_changed": {
      const sid = delta.sid as Sid;
      const prev = state.sessions.get(sid);
      if (!prev) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sid, { ...prev, status: delta.status });
      const next: Partial<AppState> = { sessions };
      if (delta.status === "compacting" || delta.status === "ended") {
        Object.assign(next, mergeCompactClear(state, sid));
      }
      return next;
    }
    case "pending_count_changed": {
      const sid = delta.sid as Sid;
      const prev = state.sessions.get(sid);
      if (!prev) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sid, { ...prev, pendingCount: delta.count });
      return { sessions };
    }
    case "last_activity_changed": {
      const sid = delta.sid as Sid;
      const prev = state.sessions.get(sid);
      if (!prev) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sid, { ...prev, lastActivityTs: delta.ts });
      return { sessions };
    }
    case "yolo_changed": {
      const sid = delta.sid as Sid;
      const prev = state.sessions.get(sid);
      if (!prev) return {};
      const sessions = new Map(state.sessions);
      sessions.set(sid, { ...prev, yoloMode: delta.yoloMode });
      return { sessions };
    }
    case "compact_suggested": {
      const sid = delta.sid as Sid;
      const compactSuggestions = new Map(state.compactSuggestions);
      compactSuggestions.set(sid, { sid: delta.sid, tokens: delta.tokens });
      return { compactSuggestions };
    }
  }
}

function mergeCompactClear(state: AppState, sid: Sid): Partial<AppState> {
  if (!state.compactSuggestions.has(sid)) return {};
  const compactSuggestions = new Map(state.compactSuggestions);
  compactSuggestions.delete(sid);
  return { compactSuggestions };
}
