import { useState } from "react";

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
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [approveForTaskPending, setApproveForTaskPending] = useState(false);

  async function decide(payload: PermissionDecision) {
    if (localPending) return;
    setLocalPending(true);
    setLocalError(null);
    try {
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
        // Mirror InputBox: surface the server's JSON `error` field if
        // present so the operator sees `scope must be...` etc instead of
        // a bare status code.
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setLocalError(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "request failed");
    } finally {
      setLocalPending(false);
    }
  }

  async function approveForTask(toolName: string, requestId: string) {
    if (approveForTaskPending || localPending) return;
    setApproveForTaskPending(true);
    setLocalError(null);
    try {
      const res = await fetch(
        `/${encodeURIComponent(sid)}/permission/approve-for-task`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool: toolName }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setLocalError(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
        return;
      }
      // Profile persisted — also resolve the current pending request
      await decide({ requestId, decision: "approve" });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "request failed");
    } finally {
      setApproveForTaskPending(false);
    }
  }

  return {
    decide,
    approveForTask,
    localPending,
    localError,
    approveForTaskPending,
  };
}
