import { useState } from "react";
import { useCreateProject } from "./hooks";

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const primaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-blue)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const fieldLabelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";
const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";

interface CreateProjectModalProps {
  onBack: () => void;
  onCreated: () => void;
}

export function CreateProjectModal({ onBack, onCreated }: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [repoDir, setRepoDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const createProject = useCreateProject();
  const pending = createProject.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Project name is required."); return; }
    if (!repoDir.trim()) { setError("Repository path is required."); return; }
    try {
      await createProject.mutateAsync({ name: name.trim(), repo_dir: repoDir.trim() });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="or-create-project">
      <header className="flex items-center gap-4">
        <button type="button" className={secondaryButtonClass} onClick={onBack}>Back</button>
        <h2 className="m-0 text-lg font-semibold text-[var(--text-primary)]">Create Project</h2>
      </header>

      <form className="flex flex-col gap-4" onSubmit={(e) => { void onSubmit(e); }}>
        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>Name</span>
          <input
            type="text"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            placeholder="my-project"
            required
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>Repository Path</span>
          <input
            type="text"
            className={inputClass}
            value={repoDir}
            onChange={(e) => setRepoDir(e.target.value)}
            disabled={pending}
            placeholder="/path/to/repo"
            required
          />
        </label>

        {error && (
          <div
            className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
            role="alert"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button type="button" className={secondaryButtonClass} onClick={onBack} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass} disabled={pending}>
            {pending ? "Creating…" : "Create Project"}
          </button>
        </div>
      </form>
    </div>
  );
}
