import { createDevFlowAdapterRegistry } from "../../src/adapters/dev-flow";
import type { WorkflowRunId } from "../../src/domain/primitives";
import type { BlockedReason, CoreStatus, NextActor } from "../../src/domain/records";
import { PostgresOperatorProjectionRepository } from "../../src/storage/postgres-operators";
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

export interface UnitRow {
  readonly cohort_id: string;
  readonly stage_instance_id: string;
  readonly unit_id: string;
  readonly params: null;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly session_id: string | null;
  readonly gate_step: string | null;
}

export interface ArtifactRow {
  readonly stage_instance_id: string;
  readonly id: string;
  readonly type_id: string;
  readonly version: number;
  readonly label: string | null;
  readonly created_at: string;
}

export interface SessionRow {
  readonly session_id: string;
  readonly stage_key: string;
  readonly cohort_id: string;
  readonly cohort_key?: string;
  readonly attempt_number: number;
  readonly attempt_count: number;
  readonly status: CoreStatus;
  readonly created_at: string;
}

interface GateRow {
  readonly wait_id: string;
  readonly run_id: string;
  readonly stage_name: string;
  readonly stage_instance_id: string;
  readonly unit_id: string;
  readonly artifact_revision_id: null;
  readonly gate_step: string;
  readonly actions: readonly string[];
  readonly repository_key: null;
  readonly run_state: CoreStatus;
}

export interface DiagnosisFixture {
  readonly stages?: readonly StageRow[];
  readonly units?: readonly UnitRow[];
  readonly artifacts?: readonly ArtifactRow[];
  readonly sessions?: readonly SessionRow[];
  readonly gates?: readonly GateRow[];
}

export class DiagnosisSql implements TransactionalSqlExecutor {
  constructor(private readonly fixture: DiagnosisFixture) {}

  async query<Row extends object>(statement: string, _parameters: readonly unknown[]): Promise<readonly Row[]> {
    let rows: readonly object[];
    if (statement.includes("AS stage_total")) {
      if (!statement.includes("FROM oakridge.wait_gate wait") || !statement.includes("verification.invalidated_at IS NULL")
        || !statement.includes("cohort.blocked_reason='retry'") || !statement.includes("cohort.next_actor='operator'")) {
        throw new Error("run attention_count must use the actionable inbox facts");
      }
      const retryAttention = (this.fixture.units ?? []).filter((unit) =>
        unit.status === "blocked" && unit.blocked_reason === "retry" && unit.next_actor === "operator").length;
      rows = [{
        id: RUN_ID, title: "Diagnosis fixture", repository_keys: [], workflow_name: "test",
        status: "active", blocked_reason: null, next_actor: "core", current_stage: null,
        stage_total: String(this.fixture.stages?.length ?? 0), stage_complete: "0", attention_count: String(retryAttention),
        parked_count: "0", updated_at: "2026-09-29T00:00:00.000Z", archived: false,
      }];
    } else if (statement.includes("FROM oakridge.stage_instance stage WHERE")) {
      rows = this.fixture.stages ?? [];
    } else if (statement.includes("FROM oakridge.cohort cohort") && statement.includes("current_session")) {
      rows = this.fixture.units ?? [];
    } else if (statement.includes("FROM oakridge.artifact artifact JOIN oakridge.artifact_owner")) {
      rows = this.fixture.artifacts ?? [];
    } else if (statement.includes("SELECT definition.definition")) {
      rows = [];
    } else if (statement.includes("FROM oakridge.dev_flow_build_cohort build")) {
      rows = [];
    } else if (statement.includes("FROM oakridge.session session") && statement.includes("attempt_count")) {
      if (!statement.includes("max(a2.attempt_number)") || !statement.includes("JOIN oakridge.cohort cohort")) {
        throw new Error("diagnosis attempt_count must include unbound attempts and cohort_key");
      }
      rows = (this.fixture.sessions ?? []).map((row) => ({ ...row, cohort_key: row.cohort_key ?? row.cohort_id }));
    } else if (statement.includes("FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage")) {
      rows = [];
    } else if (statement.includes("FROM oakridge.wait_gate wait")) {
      rows = this.fixture.gates ?? [];
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
  name: `stage-${index}`,
  stage_type: "delegated_session",
  operator_role: null,
  status,
  blocked_reason: status === "blocked" ? "gate" : null,
  next_actor: status === "blocked" ? "operator" : status === "complete" || status === "failed" || status === "cancelled" ? null : "core",
});

export const diagnosisOf = (fixture: DiagnosisFixture) =>
  new PostgresOperatorProjectionRepository(new DiagnosisSql(fixture), "test-app-version", createDevFlowAdapterRegistry())
    .get_run_diagnosis(RUN_ID);
