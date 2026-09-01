import { create } from "zustand";

import type { Sid } from "../lib/ids";
import type { SessionSnapshot, Status } from "../types";

export interface AppState {
  /**
   * Session map: ACP sessions come from the /inbox snapshot stream (the
   * authority); archived pre-ACP sessions come from the one-shot
   * /sessions?include=archived seed and are kept across snapshot frames
   * (the stream never carries them).
   */
  sessions: Map<Sid, SessionSnapshot>;
  inboxStatus: Status;
  currentSid: Sid | null;
  /** Sids removed server-side; blocks a late seed from resurrecting them. */
  removedSids: Set<Sid>;

  hydrateSession: (snapshot: SessionSnapshot) => void;
  seedSessions: (snapshots: SessionSnapshot[]) => void;
  /**
   * Fold one authoritative /inbox snapshot frame: replaces every
   * ACP-sourced entry wholesale, keeps archived-legacy entries, and
   * returns the sids that disappeared so the caller can navigate away
   * from a purged session.
   */
  applySnapshot: (snapshots: SessionSnapshot[]) => Sid[];
  setInboxStatus: (status: Status) => void;
  setCurrentSid: (sid: Sid | null) => void;
}

export const useStore = create<AppState>()((set) => ({
  sessions: new Map(),
  inboxStatus: "connecting",
  currentSid: null,
  removedSids: new Set(),

  // Fold a snapshot we already have in hand (e.g. the response body of
  // POST /sessions) so the destination view mounts with the snapshot
  // present instead of racing the next /inbox frame — which re-seats the
  // same entry harmlessly.
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
      return { sessions, removedSids };
    }),

  // Seed from /sessions?include=archived: entries the stream hasn't (or
  // won't ever) deliver are folded in without overwriting fresher ones.
  seedSessions: (snapshots) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      for (const snapshot of snapshots) {
        const sid = snapshot.sid as Sid;
        if (state.removedSids.has(sid)) continue;
        if (!sessions.has(sid)) sessions.set(sid, snapshot);
      }
      return { sessions };
    }),

  applySnapshot: (snapshots) => {
    const removed: Sid[] = [];
    set((state) => {
      const incoming = new Map(
        snapshots.map((snapshot) => [snapshot.sid as Sid, snapshot]),
      );
      const sessions = new Map<Sid, SessionSnapshot>();
      for (const [sid, snapshot] of incoming) sessions.set(sid, snapshot);
      for (const [sid, existing] of state.sessions) {
        if (incoming.has(sid)) continue;
        if (existing.source === "legacy_archive") {
          sessions.set(sid, existing);
        } else {
          removed.push(sid);
        }
      }
      const removedSids = new Set(state.removedSids);
      for (const sid of incoming.keys()) removedSids.delete(sid);
      for (const sid of removed) removedSids.add(sid);
      return { sessions, removedSids };
    });
    return removed;
  },

  setInboxStatus: (inboxStatus) => set({ inboxStatus }),
  setCurrentSid: (currentSid) => set({ currentSid }),
}));
