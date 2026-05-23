import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SidebarProject } from "./Sidebar";

interface AddSpecModalProps {
  project: SidebarProject;
  onCreated: () => void;
  onCancel: () => void;
}

export function AddSpecModal({ project, onCreated, onCancel }: AddSpecModalProps) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async (vars: { title: string; notes: string }) => {
      const body: { project_id: string; title: string; notes?: string } = {
        project_id: project.id,
        title: vars.title,
      };
      if (vars.notes) body.notes = vars.notes;
      const res = await fetch("/specs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const respBody = (await res.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(
          typeof respBody?.error === "string"
            ? respBody.error
            : `server returned ${res.status}`,
        );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["specs", { projectId: project.id }],
      });
    },
  });

  async function submit() {
    if (createMutation.isPending) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("title is required");
      return;
    }
    setError(null);
    try {
      await createMutation.mutateAsync({
        title: trimmedTitle,
        notes: notes.trim(),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    }
  }

  const pending = createMutation.isPending;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={() => {
        if (!pending) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-spec-title"
        style={{
          background: "var(--bg-surface, #1e1e1e)",
          border: "1px solid var(--border-subtle, #444)",
          borderRadius: 8,
          padding: 24,
          width: "min(480px, 90vw)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          boxSizing: "border-box",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="add-spec-title" style={{ fontWeight: 600, fontSize: 15 }}>
          New plan / epic — <span style={{ opacity: 0.7 }}>{project.name}</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span style={{ opacity: 0.8 }}>Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short one-line summary"
              spellCheck={false}
              disabled={pending}
              autoFocus
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span style={{ opacity: 0.8 }}>Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Context, constraints, links — anything planner1 should know."
              rows={10}
              style={{ fontSize: 13, resize: "vertical", width: "100%", boxSizing: "border-box" }}
              disabled={pending}
            />
          </label>
          {error && (
            <div style={{ color: "var(--danger-fg, #e67070)", fontSize: 13 }} role="alert">
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onCancel} disabled={pending}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !title.trim()}
            >
              {pending ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
