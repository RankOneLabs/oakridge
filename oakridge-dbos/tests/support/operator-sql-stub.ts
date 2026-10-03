import type { WorkflowRunId } from "../../src/domain/primitives";
import type { BlockedReason, CoreStatus, NextActor } from "../../src/domain/records";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../src/storage/sql-executor";

export const RUN_ID = "10000000-0000-0000-0000-000000000001" as WorkflowRunId;

interface StageRow {
  readonly stage_instance_id: string;
  readonly name: string;
  readonly stage_type: string;
  readonly operator_role: string | null;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
}

export interface DiagnosisFixture {
  readonly stages?: readonly StageRow[];
}

export class DiagnosisSql implements TransactionalSqlExecutor {
  constructor(private readonly fixture: DiagnosisFixture) {}

  async query<Row extends object>(statement: string, _parameters: readonly unknown[]): Promise<readonly Row[]> {
    let rows: readonly object[];
    if (statement.includes("AS stage_total")) {
      rows = [{
        id: RUN_ID, title: "Diagnosis fixture", repository_keys: [], workflow_name: "test",
        status: "active", blocked_reason: null, next_actor: "core", current_stage: null,
        stage_total: String(this.fixture.stages?.length ?? 0), stage_complete: "0", attention_count: "0",
        parked_count: "0", updated_at: "2026-09-29T00:00:00.000Z", archived: false,
      }];
    } else if (statement.includes("FROM oakridge.stage_instance stage WHERE")) {
      rows = this.fixture.stages ?? [];
    } else if (statement.includes("FROM oakridge.cohort cohort") && statement.includes("current_session")) {
      rows = [];
    } else if (statement.includes("FROM oakridge.artifact artifact JOIN oakridge.artifact_owner")) {
      rows = [];
    } else if (statement.includes("SELECT definition.definition")) {
      rows = [];
    } else if (statement.includes("FROM dev_flow.build_cohort build")) {
      rows = [];
    } else if (statement.includes("FROM oakridge.session session")) {
      rows = [];
    } else if (statement.includes("FROM oakridge.cohort_worker worker")
      || statement.includes("FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage")) {
      rows = [];
    } else {
      throw new Error(`unexpected diagnosis query: ${statement.slice(0, 80)}`);
    }
    return rows as readonly Row[];
  }

  transaction<Value>(operation: (transaction: SqlExecutor) => Promise<Value>): Promise<Value> {
    return operation(this);
  }
}

export const stage = (index: number, status: CoreStatus): StageRow => ({
  stage_instance_id: `20000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
  name: "spec_analysis",
  stage_type: "delegated_session",
  operator_role: null,
  status,
  blocked_reason: status === "blocked" ? "gate" : null,
  next_actor: status === "blocked" ? "operator" : status === "complete" || status === "failed" || status === "cancelled" ? null : "core",
});
