import { useMutation } from "@tanstack/react-query";

import { sessionCloseError } from "../lib/session-close";

/** Close a session while keeping its transcript available for review or resume. */
export function useEndSession(sessionId: string) {
  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw await sessionCloseError(response);
    },
  });
  const error = mutation.isError
    ? mutation.error instanceof Error ? mutation.error.message : "Could not end the session."
    : null;
  return { mutation, error };
}
