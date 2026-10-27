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
      useStore.getState().archiveSession({ kind: "end_and_archive", sid: sessionId as Sid });
    },
  });
  const error = mutation.isError
    ? mutation.error instanceof Error ? mutation.error.message : "Could not end the session."
    : null;
  return { mutation, error };
}
