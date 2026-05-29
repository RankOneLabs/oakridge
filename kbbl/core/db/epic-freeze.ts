import { Database } from "bun:sqlite";
import type { Epic } from "../types/task-tracker";

/**
 * Returns true when the Epic is archived (write operations should be rejected).
 * Handlers operating on non-Epic artifacts resolve epic_id via the FK chain
 * (artifact → spec → epic) before calling this function.
 *
 * Note: archive does NOT auto-kill running sessions; the operator stops them
 * manually via DELETE /sessions/:sid. This function only gates future writes.
 */
export function isFrozen(db: Database, epic_id: string): boolean {
  const row = db
    .prepare<{ status: string }, [string]>("SELECT status FROM epics WHERE id = ?")
    .get(epic_id);
  return row?.status === "archived";
}

/**
 * Returns true when the planner_* routing knobs are frozen.
 * Planner knobs freeze the moment the Epic leaves the Spec stage
 * (epic_spec_approved advances spec → plan). Archived epics are always frozen.
 */
export function isPlannerFrozen(epic: Epic): boolean {
  return epic.status === "archived" || epic.current_stage !== "spec";
}

/**
 * Returns true when the build_* routing knobs are frozen.
 * Build knobs freeze the moment the Epic enters the Build stage
 * (epic_plan_approved advances plan → build). Archived epics are always frozen.
 */
export function isBuildFrozen(epic: Epic): boolean {
  return epic.status === "archived" || epic.current_stage === "build" || epic.current_stage === "assess";
}
