/**
 * What an epic launch configures, after the profile table it used to live in.
 *
 * `oakridge.epic_workflow_profile` does not exist in v15. Four of its five
 * fields already had v15 homes — `prepareRunContext` writes `base_branch` and
 * `repositories[{key,path,integration_branch}]` into `workflow_run.context`,
 * and 0016's own comment records that the profile "is never consulted by core"
 * — so the two that did not (`forge_repository` per repository, and the epic's
 * `final_merge_policy`) moved onto the run context beside them rather than
 * keeping a table alive for two values.
 *
 * `final_pull_request` and `final_merge_state` were mutable state, not launch
 * configuration, and 0016's `pull_request`/`pull_request_verification`/
 * `pull_request_merge_closure` family is where that state lives now.
 */

/** How a final epic pull request is allowed to complete. */
export type FinalMergePolicy = "guarded" | "external_confirmation";

/**
 * The independent authority a candidate pull request URL is checked against.
 *
 * Launch configuration, deliberately: `verifyCohortPullRequest` compares an
 * agent-supplied URL to this, so it cannot come from an artifact the agent
 * wrote. `oakridge.project.forge_repository` is the wrong home for the same
 * reason it always was — one identity per project cannot express a
 * multi-repository epic.
 */
export interface ForgeRepositoryIdentity { readonly provider: "github"; readonly owner: string; readonly name: string }

export interface PullRequestReference { readonly number: number; readonly url: string; readonly head_branch: string; readonly base_branch: string }
