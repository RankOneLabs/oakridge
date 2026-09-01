import { useMutation } from "@tanstack/react-query";

// Answers one ACP permission request with exactly the option the agent
// offered (§15.2) — POST /sessions/:sid/permissions/:requestId. The card
// retires when the stream delivers the permission_resolved event, not
// optimistically, so every connected client converges on the same state.
export function usePermissionAnswer(sid: string) {
  return useMutation({
    mutationFn: async (payload: { requestId: string; optionId: string }) => {
      const res = await fetch(
        `/sessions/${encodeURIComponent(sid)}/permissions/${encodeURIComponent(payload.requestId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ option_id: payload.optionId }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    },
  });
}
