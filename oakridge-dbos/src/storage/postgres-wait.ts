import type { ArtifactId, RunUnitId, StageInstanceId, UnitId, WaitId } from "../domain/primitives";
import type { Wait, WaitClosesOn, WaitOutcome } from "../domain/wait";

export interface WaitRow {
  readonly id: string;
  readonly stage_instance_id: string;
  readonly unit_id: string;
  readonly artifact_revision_id: string;
  readonly closes_on: WaitClosesOn;
  readonly status: "open" | "closed";
  readonly outcome: WaitOutcome | null;
  readonly run_unit_id: string | null;
  readonly output_name: string | null;
  readonly execution_workflow_id: string;
  readonly command_workflow_id: string;
  readonly opened_at: string;
  readonly closed_at: string | null;
}

/** Exported so `postgres-run-record.ts` can read the same rows inside its own transaction — the v2 wait open/close it does directly must see one shape. */
export const waitColumns = `wait.id::text, wait.stage_instance_id::text, wait.unit_id, wait.artifact_revision_id::text,
       wait.closes_on, wait.status, wait.outcome, wait.run_unit_id::text, wait.output_name,
       wait.execution_workflow_id, wait.command_workflow_id, wait.opened_at::text, wait.closed_at::text`;

export const decodeWait = (row: WaitRow): Wait => {
  if (row.status === "closed" && (row.outcome === null || row.closed_at === null)) {
    throw new Error(`wait '${row.id}' is closed without an outcome`);
  }
  return {
    id: row.id as WaitId,
    stage_instance_id: row.stage_instance_id as StageInstanceId,
    unit_id: row.unit_id as UnitId,
    artifact_revision_id: row.artifact_revision_id as ArtifactId,
    closes_on: row.closes_on,
    status: row.status === "open" ? { kind: "open" } : { kind: "closed", outcome: row.outcome!, closed_at: row.closed_at! },
    run_unit_id: row.run_unit_id as RunUnitId | null,
    output_name: row.output_name,
    execution_workflow_id: row.execution_workflow_id,
    command_workflow_id: row.command_workflow_id,
    opened_at: row.opened_at,
  };
};
