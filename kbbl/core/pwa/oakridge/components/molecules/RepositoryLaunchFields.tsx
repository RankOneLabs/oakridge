import type { ProjectFormValues } from "../../lib/project-draft";

interface Props { readonly values: ProjectFormValues; readonly onChange: (next: ProjectFormValues) => void; readonly disabled: boolean }
export function RepositoryLaunchFields({ values, onChange, disabled }: Props) {
  return <fieldset className="or-repository-launch"><legend>Repository</legend>
    <label>Directory<input value={values.repo_dir} required disabled={disabled} onChange={(event) => onChange({ ...values, repo_dir: event.target.value })} /></label>
    <label>GitHub owner<input value={values.owner} disabled={disabled} onChange={(event) => onChange({ ...values, owner: event.target.value })} /></label>
    <label>GitHub repository<input value={values.repository} disabled={disabled} onChange={(event) => onChange({ ...values, repository: event.target.value })} /></label>
    <label>Integration branch<input value={values.integration_branch} disabled={disabled} onChange={(event) => onChange({ ...values, integration_branch: event.target.value })} /></label>
  </fieldset>;
}
