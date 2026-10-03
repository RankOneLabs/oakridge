/** Read-only vocabulary for validating graph fixtures during the cutover.
 * No guard implementation or effect handler is registered here.
 */
export const legacyMachineVocabulary = {
  guards: ["pr_matches_cohort", "pr_merged_into_base", "pr_closed_unmerged", "briefs_cover_plan", "briefs_acyclic"],
  effects: ["bind_pull_request", "unbind_pull_request", "record_merge"],
  observers: ["pr_watcher"],
} as const;
