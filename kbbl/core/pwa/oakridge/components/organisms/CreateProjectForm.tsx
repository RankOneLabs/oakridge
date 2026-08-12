import { useState } from "react";
import { useCreateProject } from "../../hooks/useCreateProject";
import { Button } from "../atoms/Button";
import { FeedbackMessage } from "../atoms/FeedbackMessage";
import { FormField, formControlClass } from "../molecules/FormField";
import { PageHeader } from "../molecules/PageHeader";

interface CreateProjectFormProps {
  onBack: () => void;
  onCreated: () => void;
}

export function CreateProjectForm({ onBack, onCreated }: CreateProjectFormProps) {
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
    <div className="or-page or-page--form" data-testid="or-create-project">
      <PageHeader
        backAction={<Button onClick={onBack}>Back</Button>}
        eyebrow="Repository context"
        title="Create project"
        summary="Register a repository so workflow runs can target it consistently."
      />

      <form className="or-form-card flex flex-col gap-4" onSubmit={(e) => { void onSubmit(e); }}>
        <FormField label="Name">
          <input
            type="text"
            className={formControlClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            placeholder="my-project"
            required
          />
        </FormField>

        <FormField label="Repository Path">
          <input
            type="text"
            className={formControlClass}
            value={repoDir}
            onChange={(e) => setRepoDir(e.target.value)}
            disabled={pending}
            placeholder="/path/to/repo"
            required
          />
        </FormField>

        {error && <FeedbackMessage tone="danger">{error}</FeedbackMessage>}

        <div className="flex justify-end gap-3">
          <Button onClick={onBack} disabled={pending}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Creating…" : "Create Project"}
          </Button>
        </div>
      </form>
    </div>
  );
}
