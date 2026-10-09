import type { OperatorProjectDraft } from "../operator-contracts";

/** The project form's text fields. */
export interface ProjectFormValues { readonly name: string; readonly repo_dir: string; readonly owner: string; readonly repository: string; readonly integration_branch: string }
export const EMPTY_PROJECT_FORM: ProjectFormValues = { name: "", repo_dir: "", owner: "", repository: "", integration_branch: "" };

/** Form text as the project the API stores: blank optional values are absent, not empty strings. */
export function selectProjectDraft(values: ProjectFormValues): OperatorProjectDraft {
  const owner = values.owner.trim();
  const repository = values.repository.trim();
  const branch = values.integration_branch.trim();
  return { name: values.name.trim(), repo_dir: values.repo_dir.trim(),
    forge_repository: owner && repository ? { provider: "github", owner, name: repository } : null,
    integration_branch: branch === "" ? null : branch };
}
