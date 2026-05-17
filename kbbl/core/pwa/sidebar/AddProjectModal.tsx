import { useState } from "react";

interface AddProjectModalProps {
  onCreated: () => void;
  onCancel: () => void;
}

export function AddProjectModal({ onCreated, onCancel }: AddProjectModalProps) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (pending) return;
    const trimmedName = name.trim();
    const trimmedPath = repoPath.trim();
    if (!trimmedName) {
      setError("name is required");
      return;
    }
    if (!trimmedPath.startsWith("/")) {
      setError("repo_path must be an absolute path");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmedName, repo_path: trimmedPath }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof body?.error === "string" ? body.error : `server returned ${res.status}`);
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
          width: "min(400px, 90vw)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          boxSizing: "border-box",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, fontSize: 15 }}>New project</div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          <span style={{ opacity: 0.8 }}>Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-project"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={pending}
            autoFocus
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          <span style={{ opacity: 0.8 }}>Repo path</span>
          <input
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/absolute/path/to/repo"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
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
            disabled={pending || !name.trim() || !repoPath.trim()}
          >
            {pending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
