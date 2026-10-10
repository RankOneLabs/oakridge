import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createOperatorProject } from "../../client";
import { queryKeys } from "../../queryKeys";
import { EMPTY_PROJECT_FORM, selectProjectDraft, type ProjectFormValues } from "../../lib/project-draft";
import { RepositoryLaunchFields } from "../molecules/RepositoryLaunchFields";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly onCreated: () => void }
export function CreateProjectForm({ onCreated }: Props) {
  const client = useQueryClient();
  const [values, setValues] = useState<ProjectFormValues>(EMPTY_PROJECT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null); setIsSaving(true);
    try { await createOperatorProject(selectProjectDraft(values));
      void client.invalidateQueries({ queryKey: queryKeys.projects }); onCreated(); }
    catch (cause) { setError(String(cause)); }
    finally { setIsSaving(false); }
  };
  return <form onSubmit={(event) => void save(event)} className="flex flex-col gap-3" data-testid="or-project-form">
    <label>Project name<input value={values.name} required disabled={isSaving} onChange={(event) => setValues({ ...values, name: event.target.value })} /></label>
    <RepositoryLaunchFields values={values} onChange={setValues} disabled={isSaving} />
    {error && <p role="alert">{error}</p>}
    <Button type="submit" disabled={isSaving}>{isSaving ? "Creating…" : "Create project"}</Button>
  </form>;
}
