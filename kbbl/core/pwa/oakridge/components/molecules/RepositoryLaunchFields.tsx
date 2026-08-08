import type { Dispatch, SetStateAction } from "react";

import type { RepositoryInputDraft } from "../../types";

interface RepositoryLaunchFieldsProps {
  repositories: RepositoryInputDraft[];
  setRepositories: Dispatch<SetStateAction<RepositoryInputDraft[]>>;
  disabled: boolean;
}

const secondaryButtonClass = "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const inputClass = "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";

export function RepositoryLaunchFields({ repositories, setRepositories, disabled }: RepositoryLaunchFieldsProps) {
  const update = (index: number, patch: Partial<RepositoryInputDraft>) => {
    setRepositories((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-[var(--border-subtle)] p-3">
      <div className="flex items-center justify-between gap-3">
        <legend className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Repositories</legend>
        <button type="button" className={secondaryButtonClass} disabled={disabled} onClick={() => setRepositories((current) => [...current, { key: "", path: "", forge_owner: "", forge_name: "", base_branch: "main" }])}>+ Repository</button>
      </div>
      {repositories.map((repository, index) => (
        <div className="or-repository-fields" key={index}>
          <input type="text" className={inputClass} value={repository.key} onChange={(event) => update(index, { key: event.target.value })} disabled={disabled} placeholder="Key (api)" aria-label={`Repository ${index + 1} key`} required />
          <input type="text" className={inputClass} value={repository.forge_owner} onChange={(event) => update(index, { forge_owner: event.target.value })} disabled={disabled} placeholder="GitHub owner" aria-label={`Repository ${index + 1} GitHub owner`} required />
          <input type="text" className={inputClass} value={repository.forge_name} onChange={(event) => update(index, { forge_name: event.target.value })} disabled={disabled} placeholder="GitHub repository" aria-label={`Repository ${index + 1} GitHub name`} required />
          <input type="text" className={inputClass} value={repository.base_branch} onChange={(event) => update(index, { base_branch: event.target.value })} disabled={disabled} placeholder="Base branch (main)" aria-label={`Repository ${index + 1} base branch`} required />
          <input type="text" className={inputClass} value={repository.path} onChange={(event) => update(index, { path: event.target.value })} disabled={disabled} placeholder="/absolute/path/to/repo" aria-label={`Repository ${index + 1} path`} required />
          <button type="button" className={secondaryButtonClass} disabled={disabled || repositories.length === 1} onClick={() => setRepositories((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove repository ${index + 1}`}>Remove</button>
        </div>
      ))}
    </fieldset>
  );
}
