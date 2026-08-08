export interface EpicBranchError {
  operation: "validate_epic_branch";
  detail: string;
}

export type EpicBranchResult =
  | { ok: true; branch: string }
  | { ok: false; error: EpicBranchError };

export function validateEpicBranch(value: string): EpicBranchResult {
  const branch = value.trim();
  if (!branch) {
    return { ok: false, error: { operation: "validate_epic_branch", detail: "Epic integration branch is required." } };
  }
  if (!branch.startsWith("epic/")) {
    return { ok: false, error: { operation: "validate_epic_branch", detail: "Epic integration branch must start with epic/." } };
  }
  if (/\s|\.\.|[~^:?*[\\]/.test(branch) || branch.endsWith("/") || branch.endsWith(".")) {
    return { ok: false, error: { operation: "validate_epic_branch", detail: "Enter a valid Git branch name." } };
  }
  return { ok: true, branch };
}
