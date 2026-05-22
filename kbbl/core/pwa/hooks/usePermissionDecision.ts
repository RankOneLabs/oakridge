import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

export type PermissionDecision = {
  requestId: string;
  decision: "approve" | "deny";
  scope?: "once" | "always";
};

export function usePermissionDecision(sid: string): {
  decide: (payload: PermissionDecision) => Promise<void>;
  approveForTask: (toolName: string, requestId: string) => Promise<void>;
  localPending: boolean;
  localError: string | null;
  approveForTaskPending: boolean;
} {
  const [localError, setLocalError] = useState<string | null>(null);

  const decideMutation = useMutation({
    mutationFn: async (payload: PermissionDecision) => {
      const res = await fetch(`/${encodeURIComponent(sid)}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: payload.requestId,
          decision: payload.decision,
          scope: payload.scope ?? "once",
        }),
      });
      if (!res.ok) {
        // Mirror InputBox: surface the server's JSON `error` field so the
        // operator sees `scope must be...` etc instead of a bare status.
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

  const approveForTaskMutation = useMutation({
    mutationFn: async (vars: { toolName: string; requestId: string }) => {
      const res = await fetch(
        `/${encodeURIComponent(sid)}/permission/approve-for-task`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool: vars.toolName }),
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

  async function decide(payload: PermissionDecision) {
    if (decideMutation.isPending) return;
    setLocalError(null);
    try {
      await decideMutation.mutateAsync(payload);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "request failed");
    }
  }

  async function approveForTask(toolName: string, requestId: string) {
    if (approveForTaskMutation.isPending || decideMutation.isPending) return;
    setLocalError(null);
    try {
      await approveForTaskMutation.mutateAsync({ toolName, requestId });
      // Profile persisted — also resolve the current pending request
      await decide({ requestId, decision: "approve" });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "request failed");
    }
  }

  return {
    decide,
    approveForTask,
    localPending: decideMutation.isPending,
    localError,
    approveForTaskPending: approveForTaskMutation.isPending,
  };
}
