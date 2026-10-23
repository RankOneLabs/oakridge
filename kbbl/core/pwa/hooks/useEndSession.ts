import { useMutation } from "@tanstack/react-query";

import { sessionCloseError } from "../lib/session-close";
import type { Sid } from "../lib/ids";
import { useStore } from "../state/store";

/** End and archive a session while retaining its transcript and session identity. */
export function useEndSession(sessionId: string) {
  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}?archive=true`, {
        method: "DELETE",
      });
      if (!response.ok) throw await sessionCloseError(response);
    },
    onSuccess: () => {
      useStore.setState((state) => {
        const sid = sessionId as Sid;
        const session = state.sessions.get(sid);
        if (!session) return state;
        const sessions = new Map(state.sessions);
        const status = session.status === "ended" || session.status === "fenced" || session.status === "failed"
          ? session.status
          : "ended";
        sessions.set(sid, { ...session, status, archivedAt: new Date().toISOString() });
        return { sessions };
      });
    },
  });
  const error = mutation.isError
    ? mutation.error instanceof Error ? mutation.error.message : "Could not end the session."
    : null;
  return { mutation, error };
}
