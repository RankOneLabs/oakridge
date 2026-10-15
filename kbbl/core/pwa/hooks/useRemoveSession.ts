import { useMutation } from "@tanstack/react-query";

import type { Sid } from "../lib/ids";
import { refusalOf, sessionCloseError } from "../lib/session-close";
import { useStore } from "../state/store";

export interface RemoveSessionInput {
  readonly force: boolean;
}

/** The one guarded PWA path for purging a session. */
export function useRemoveSession(sessionId: string) {
  const mutation = useMutation({
    mutationFn: async ({ force }: RemoveSessionInput) => {
      const query = force ? "?purge=true&force=1" : "?purge=true";
      const response = await fetch(
        `/sessions/${encodeURIComponent(sessionId)}${query}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw await sessionCloseError(response);
    },
    onSuccess: () => {
      // The inbox snapshot will remove the session itself. Mark the sid now so
      // an open run pane and the Oakridge attempt list stop offering it in the
      // same render as the successful purge response.
      useStore.setState((state) => ({
        removedSids: new Set([...state.removedSids, sessionId as Sid]),
      }));
    },
  });
  const receivedRefusal = mutation.isError ? refusalOf(mutation.error) : null;
  // The frozen v1 sidebar names this overridable hold by its former tag.
  const refusal = receivedRefusal?.kind === "held_by_attempt"
    ? { ...receivedRefusal, kind: "held_by_execution" as const }
    : receivedRefusal;
  const error = mutation.isError
    ? (refusal?.message ??
      (mutation.error instanceof Error
        ? mutation.error.message
        : "Could not remove the session."))
    : null;

  return { mutation, refusal, error };
}
