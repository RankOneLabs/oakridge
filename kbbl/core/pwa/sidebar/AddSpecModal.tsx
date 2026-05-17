import { useState } from "react";
import type { SidebarProject } from "./Sidebar";

interface AddSpecModalProps {
  project: SidebarProject;
  onCreated: () => void;
  onCancel: () => void;
}

export function AddSpecModal({ project, onCreated, onCancel }: AddSpecModalProps) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (pending) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("title is required");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const body: { project_id: string; title: string; notes?: string } = {
        project_id: project.id,
        title: trimmedTitle,
      };
      const trimmedNotes = notes.trim();
      if (trimmedNotes) body.notes = trimmedNotes;
      const res = await fetch("/specs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const respBody = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof respBody?.error === "string" ? respBody.error : `server returned ${res.status}`);
        return;
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
      setPending(false);
    }
  }

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
      onClick={onCancel}
    >
      <div
        style={{
          background: "var(--bg-surface, #1e1e1e)",
          border: "1px solid var(--border-subtle, #444)",
          borderRadius: 8,
          padding: 24,
          minWidth: 480,
          maxWidth: "90vw",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          New plan / epic — <span style={{ opacity: 0.7 }}>{project.name}</span>
        </div>
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
            type="button"
            onClick={submit}
            disabled={pending || !title.trim()}
          >
            {pending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
