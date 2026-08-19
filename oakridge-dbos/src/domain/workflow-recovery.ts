import type { OperatorApplicationVersionInventory } from "./operator-projections";

/**
 * Whether a PENDING workflow row is one this executor could still pick up.
 *
 * PENDING is not the same as alive. DBOS recovers a workflow only when its
 * `application_version` matches the executor's own — `getPendingWorkflows`
 * filters on it — so a workflow left PENDING by a previous version is never
 * resumed and never terminalizes. Its row stays indistinguishable from a
 * running one, forever.
 *
 * Every "is this still running?" question in the system reads that row, and
 * each one that mistakes an orphan for a live workflow fails the same way: it
 * waits on something that will never arrive. A session became permanently
 * unclosable; cancellation blocked on a wait nobody would ever answer. One
 * predicate, so the next such question is asked correctly by construction.
 */
export type WorkflowRecovery =
  /** A workflow this executor serves. It may still run, so treat it as live. */
  | { readonly kind: "recoverable" }
  /**
   * Stranded at a version this executor does not serve. Nothing will resume it,
   * so nothing should wait on it.
   */
  | { readonly kind: "abandoned"; readonly holder_application_version: string };

/**
 * Assumes a single executor per system database — the deployment
 * `oakridge-start` produces, where every workflow row carries
 * `executor_id = 'local'`. Deliberately running a second executor on an older
 * version (the runbook's "keep the old executor available until those runs
 * drain") would make its version live too, and this would need a registry of
 * serving versions rather than just our own.
 *
 * Both unknowns resolve to "recoverable", because the two mistakes do not cost
 * the same. Calling a live workflow abandoned means cancelling a gate somebody
 * is still waiting on — real work destroyed. Calling an orphan live means the
 * old symptom: something waits on a workflow that will never answer, which is
 * recoverable by hand. So a null holder version (a row predating version-tagged
 * workflows) and an empty executor version (no version configured, nothing
 * meaningful to compare against) both keep the benefit of the doubt.
 */
export const selectWorkflowRecovery = (
  holder_application_version: string | null,
  executor_application_version: string,
): WorkflowRecovery =>
  holder_application_version === null
    || executor_application_version === ""
    || holder_application_version === executor_application_version
    ? { kind: "recoverable" }
    : { kind: "abandoned", holder_application_version };

/**
 * Runs this executor has inherited but cannot move: started under an older
 * application version, still counted as pending, and never going to advance.
 */
export interface OrphanedVersionRuns {
  readonly application_version: string;
  readonly pending_run_count: number;
  readonly gated_run_count: number;
  readonly oldest_pending_at: string | null;
}

/**
 * The abandoned runs an inventory of application versions is hiding.
 *
 * Every symptom of an orphaned run is remote from its cause: a session that
 * will not close, a cancel that hangs, a gate whose approval lands on a
 * workflow that returned. The cause is a number this query already knows and
 * nothing ever read out loud, so finding it took a session of DB forensics.
 * Reported at startup, it is the first thing in the log.
 *
 * A version with no pending runs is not a problem — old versions accumulate
 * normally as the code moves, and only the ones still owed work matter.
 */
export const selectOrphanedVersionRuns = (
  inventory: readonly OperatorApplicationVersionInventory[],
  executor_application_version: string,
): readonly OrphanedVersionRuns[] =>
  inventory.flatMap((entry) => {
    if (entry.pending_run_count === 0) return [];
    const recovery = selectWorkflowRecovery(entry.application_version, executor_application_version);
    if (recovery.kind === "recoverable") return [];
    return [{
      application_version: recovery.holder_application_version,
      pending_run_count: entry.pending_run_count,
      gated_run_count: entry.gated_run_count,
      oldest_pending_at: entry.oldest_pending_at,
    }];
  });
