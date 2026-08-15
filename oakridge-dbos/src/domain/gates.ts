import type { ArtifactId, Brand, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";

export type GateDecisionAuditId = Brand<string, "GateDecisionAuditId">;
export type GateOutcome = "pass" | "fail" | "rerun";
export interface GateDecision { readonly outcome: GateOutcome; readonly comment: string | null; readonly feedback: string | null }
export interface GateDecisionAudit {
  readonly id: GateDecisionAuditId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly execution_id: ExecutionId;
  readonly unit_id: UnitId;
  readonly artifact_chain_id: ArtifactId;
  readonly artifact_revision_id: ArtifactId;
  readonly gate_step: string;
  readonly action: string;
  readonly operator_comment: string | null;
  readonly feedback: string | null;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly applied_at: string | null;
}
