import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ensureOk } from "../../lib/http";
import type { Theme } from "../../types";
import { useArtifactStream } from "../shared/useArtifactStream";
import { useDirectEdit } from "../shared/useDirectEdit";
import { StructuredDocEditor } from "./StructuredDocEditor";
import { ReviewShell } from "../shared/ReviewShell";
import { RunBuildButton } from "../shared/RunBuildButton";
import type { ReviewMode, Message } from "../shared/types";
import type { Brief } from "./types";

interface BriefReviewViewProps {
  id: string;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
}

export function BriefReviewView({ id, onToggleTheme, onBack }: BriefReviewViewProps) {
  const queryClient = useQueryClient();

  const briefQuery = useQuery({
    queryKey: ["briefs", { id }],
    queryFn: async (): Promise<Brief> => {
      const res = await fetch(`/briefs/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`briefs: ${res.status}`);
      return (await res.json()) as Brief;
    },
  });

  const [mode, setMode] = useState<ReviewMode>("review");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const messagesQuery = useQuery({
    queryKey: ["threads", selectedThreadId, "messages"],
    enabled: !!selectedThreadId,
    queryFn: async (): Promise<Message[]> => {
      const res = await fetch(
        `/threads/${encodeURIComponent(selectedThreadId!)}/messages`,
      );
      if (!res.ok) return [];
      return (await res.json()) as Message[];
    },
  });

  const threadMessages = useMemo(() => {
    const m = new Map<string, Message[]>();
    if (selectedThreadId && messagesQuery.data) {
      m.set(selectedThreadId, messagesQuery.data);
    }
    return m;
  }, [selectedThreadId, messagesQuery.data]);

  const { edits, threads, frozen } = useArtifactStream("build_brief", id);
  const { editAtom } = useDirectEdit("build_brief", id, "operator");

  const createThreadMutation = useMutation({
    mutationFn: async (vars: { anchor: string | null }): Promise<{ id: string }> => {
      const res = await fetch("/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "build_brief",
          target_id: id,
          anchor: vars.anchor,
        }),
      });
      if (!res.ok) throw new Error(`thread create: ${res.status}`);
      return (await res.json()) as { id: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["threads", { target_type: "build_brief", target_id: id }],
      });
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async (vars: { threadId: string; body: string }) => {
      const res = await fetch(`/threads/${encodeURIComponent(vars.threadId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: vars.body, author: "operator" }),
      });
      await ensureOk(res, "send thread message");
    },
    onSuccess: (_, vars) => {
      void queryClient.invalidateQueries({
        queryKey: ["threads", vars.threadId, "messages"],
      });
    },
  });

  const pingMutation = useMutation({
    mutationFn: async (threadId: string) => {
      const res = await fetch(`/threads/${encodeURIComponent(threadId)}/ping`, {
        method: "POST",
      });
      await ensureOk(res, "ping thread");
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async (threadId: string) => {
      const res = await fetch(`/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      });
      await ensureOk(res, "resolve thread");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["threads", { target_type: "build_brief", target_id: id }],
      });
    },
  });

  const statusMutation = useMutation({
    mutationFn: async (vars: {
      status: "approved" | "rejected";
      reason?: string;
    }) => {
      const res = await fetch(`/briefs/${encodeURIComponent(id)}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          vars.status === "rejected"
            ? { status: "rejected", reason: vars.reason }
            : { status: "approved" },
        ),
      });
      if (!res.ok) throw new Error(`status: ${res.status}`);
      return (await res.json()) as Brief;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["briefs", { id }] });
      void queryClient.invalidateQueries({
        queryKey: ["briefs", "pending_approval"],
      });
    },
  });

  const handleSelectThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId);
  }, []);

  const handleOpenThread = useCallback(
    (anchor: string) => {
      if (frozen) return;
      const existing = threads.find(
        (t) => t.anchor === anchor && t.status === "open",
      );
      if (existing) {
        handleSelectThread(existing.id);
        return;
      }
      void (async () => {
        const t = await createThreadMutation.mutateAsync({ anchor }).catch(() => null);
        if (t) setSelectedThreadId(t.id);
      })();
    },
    [threads, handleSelectThread, createThreadMutation, frozen],
  );

  const handleNewThread = useCallback(() => {
    if (frozen) return;
    void (async () => {
      const t = await createThreadMutation.mutateAsync({ anchor: null }).catch(() => null);
      if (t) setSelectedThreadId(t.id);
    })();
  }, [createThreadMutation, frozen]);

  const handleSendMessage = useCallback(
    (threadId: string, body: string) => {
      void sendMessageMutation.mutateAsync({ threadId, body }).catch(() => {});
    },
    [sendMessageMutation],
  );

  const handlePing = useCallback(
    (threadId: string) => {
      pingMutation.mutate(threadId);
    },
    [pingMutation],
  );

  const handleResolve = useCallback(
    (threadId: string) => {
      void (async () => {
        const resolved = await resolveMutation.mutateAsync(threadId).catch(() => false);
        if (resolved !== false && selectedThreadId === threadId) setSelectedThreadId(null);
      })();
    },
    [resolveMutation, selectedThreadId],
  );

  const handleEdit = useCallback(
    (anchor: string, prevValue: string | null, newValue: string) => {
      void editAtom(anchor, prevValue, newValue);
    },
    [editAtom],
  );

  const handleApprove = useCallback(async () => {
    await statusMutation.mutateAsync({ status: "approved" }).catch(() => {});
  }, [statusMutation]);

  const handleReject = useCallback(
    async (reason: string) => {
      await statusMutation.mutateAsync({ status: "rejected", reason }).catch(() => {});
    },
    [statusMutation],
  );

  if (briefQuery.isPending) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div>Loading brief…</div>
      </div>
    );
  }

  const brief = briefQuery.data;
  if (briefQuery.isError || !brief) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div className="review-error-message">
          {briefQuery.error instanceof Error ? briefQuery.error.message : "Brief not found"}
        </div>
      </div>
    );
  }

  const isPendingApproval = brief.status === "pending_approval";

  return (
    <ReviewShell
      onBack={onBack}
      artifactTypeLabel="Brief review"
      statusLabel={brief.status}
      frozen={frozen}
      actionPending={statusMutation.isPending}
      isPendingApproval={isPendingApproval}
      onToggleTheme={onToggleTheme}
      mode={mode}
      onModeChange={setMode}
      onApprove={handleApprove}
      onReject={handleReject}
      rejectSubjectLabel="brief"
      approveSubjectLabel="brief"
      artifactId={id}
      threads={threads}
      selectedThreadId={selectedThreadId}
      threadMessages={threadMessages}
      onSelectThread={handleSelectThread}
      onCloseThread={() => setSelectedThreadId(null)}
      onNewThread={handleNewThread}
      onSendMessage={handleSendMessage}
      onPing={handlePing}
      onResolve={handleResolve}
    >
      <div className="brief-canvas-scroll">
        {brief.status === "approved" && (
          <RunBuildButton briefId={brief.id} cohortId={brief.cohort_id} />
        )}
        <StructuredDocEditor
          brief={brief}
          edits={edits}
          threads={threads}
          mode={mode}
          frozen={frozen}
          onEdit={handleEdit}
          onOpenThread={handleOpenThread}
        />

        {brief.debrief && (
          <div className="brief-debrief">
            <div className="brief-debrief__label">Debrief</div>
            <div className="brief-debrief__body">{brief.debrief}</div>
          </div>
        )}
      </div>
    </ReviewShell>
  );
}
