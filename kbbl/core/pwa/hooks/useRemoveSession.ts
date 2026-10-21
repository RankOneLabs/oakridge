import { useMutation } from "@tanstack/react-query";

import type { Sid } from "../lib/ids";
import { sessionCloseError } from "../lib/session-close";
import { useStore } from "../state/store";

/** Purge a closed session after an explicit confirmation. */
export function useRemoveSession(sessionId: string) {
  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}?purge=true`, {
        method: "DELETE",
      });
      if (!response.ok) throw await sessionCloseError(response);
    },
    onSuccess: () => {
      useStore.setState((state) => ({
        removedSids: new Set([...state.removedSids, sessionId as Sid]),
      }));
    },
  });
  const error = mutation.isError
    ? mutation.error instanceof Error ? mutation.error.message : "Could not remove the session."
    : null;
  return { mutation, error };
}
