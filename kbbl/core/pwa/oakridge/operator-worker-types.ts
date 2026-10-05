/** Fields consumed from GET /runs/:id; the backend retains the full worker record. */
export type CoreStatus = "pending" | "active" | "blocked" | "complete" | "failed" | "cancelled";
export type BlockedReason = "dependency" | "gate" | "capacity" | "external" | "operator" | "retry";
export type NextActor = "core" | "agent" | "service" | "operator" | "external";
export type WorkerState = "pending" | "working" | "awaiting_review" | "accepted" | "interrupted" | "cancelled";
export type WorkerKey = "provision" | "spec" | "plan" | "brief" | "build" | "assessment" | "final_integration";
export interface OperatorWorkerRecord {
  readonly worker: WorkerKey;
  readonly record: WorkerRecordDescriptor;
}
export interface WorkerRecordDescriptor {
  readonly state: WorkerState;
  readonly interrupted: { readonly execution: { readonly detail: string } } | null;
}
/** Mirrors the brief body carried by the operator projection, not its engine inputs. */
export interface BuildBriefDescriptor {
  readonly cohort_id: string; readonly repository_key: string; readonly title: string; readonly depends_on: readonly string[];
  readonly goal: string; readonly files_in_scope: readonly string[];
  readonly decisions_made: readonly { readonly decision: string; readonly rationale: string }[];
  readonly approaches_rejected: readonly { readonly approach: string; readonly reason: string }[];
  readonly acceptance_criteria: readonly string[]; readonly next_action: string;
}
export interface AgentSettings { readonly runtime: "claude-code" | "codex"; readonly model: string | null; readonly effort: string | null }
