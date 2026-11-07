import { create } from "zustand";

import type { Sid } from "../lib/ids";
import type { PwaSessionChanges } from "../../acp/pwa-wire";
import type { SessionSnapshot, Status } from "../types";

export type SessionArchiveUpdate =
  | { readonly kind: "archive"; readonly sid: Sid }
  | { readonly kind: "end_and_archive"; readonly sid: Sid };

export interface AppState {
  /**
   * Session map, fed by the /inbox stream: the authoritative `snapshot`
   * frame opening each connection, then `changes` frames.
   */
  sessions: Map<Sid, SessionSnapshot>;
  /** False until /inbox supplies a complete ACP inventory, including an empty one. */
  hasInboxSnapshot: boolean;
  inboxStatus: Status;
  currentSid: Sid | null;
  /** Sids removed server-side; blocks a late seed from resurrecting them. */
  removedSids: Set<Sid>;

  hydrateSession: (snapshot: SessionSnapshot) => void;
  /**
   * Fold one authoritative /inbox snapshot frame: replaces every entry
   * wholesale and returns the sids that disappeared so the caller can
   * navigate away from a purged session.
   */
  applySnapshot: (snapshots: SessionSnapshot[]) => Sid[];
  /** Fold one /inbox `changes` frame; returns the sids it removed, as `applySnapshot` does. */
  applyChanges: (changes: PwaSessionChanges) => Sid[];
  archiveSession: (update: SessionArchiveUpdate) => void;
  setInboxStatus: (status: Status) => void;
  setCurrentSid: (sid: Sid | null) => void;
}

export const useStore = create<AppState>()((set) => ({
  sessions: new Map(),
  hasInboxSnapshot: false,
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

  applySnapshot: (snapshots) => {
    const removed: Sid[] = [];
    set((state) => {
      const incoming = new Map(
        snapshots.map((snapshot) => [snapshot.sid as Sid, snapshot]),
      );
      const sessions = new Map<Sid, SessionSnapshot>();
      // Preserve the established order of existing rows. The server sorts
      // each frame by exact timestamps, but the UI deliberately treats two
      // "just now" rows as tied; rebuilding in server order would defeat
      // that stable tie every time either session emitted an event.
      for (const sid of state.sessions.keys()) {
        const replacement = incoming.get(sid);
        if (replacement !== undefined) {
          sessions.set(sid, replacement);
          continue;
        }
        removed.push(sid);
      }
      // Truly new sessions have no prior position and follow the frame's
      // authoritative order until subsequent snapshots preserve it.
      for (const [sid, snapshot] of incoming) {
        if (!sessions.has(sid)) sessions.set(sid, snapshot);
      }
      const removedSids = new Set(state.removedSids);
      for (const sid of incoming.keys()) removedSids.delete(sid);
      for (const sid of removed) removedSids.add(sid);
      return { sessions, removedSids, hasInboxSnapshot: true };
    });
    return removed;
  },

  applyChanges: (changes) => {
    const removed: Sid[] = [];
    set((state) => {
      // Map.set keeps an existing row's position, so the stable tie described
      // in applySnapshot holds here too.
      const sessions = new Map(state.sessions);
      const removedSids = new Set(state.removedSids);
      for (const session of changes.sessions) {
        sessions.set(session.sid as Sid, session);
        removedSids.delete(session.sid as Sid);
      }
      for (const sid of changes.removedSids as Sid[]) {
        if (sessions.delete(sid)) removed.push(sid);
        removedSids.add(sid);
      }
      return { sessions, removedSids };
    });
    return removed;
  },

  archiveSession: (update) =>
    set((state) => {
      const session = state.sessions.get(update.sid);
      if (!session) return state;
      const sessions = new Map(state.sessions);
      // The single-row action can end a live session. Bulk hide only archives
      // terminal sessions, so it preserves their status without a fallback.
      const status = update.kind === "end_and_archive" &&
        session.status !== "ended" && session.status !== "fenced" && session.status !== "failed"
        ? "ended"
        : session.status;
      sessions.set(update.sid, { ...session, status, archivedAt: new Date().toISOString() });
      return { sessions };
    }),

  setInboxStatus: (inboxStatus) => set({ inboxStatus }),
  setCurrentSid: (currentSid) => set({ currentSid }),
}));
