import { describe, expect, test } from "bun:test";

import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import type { WorkflowRunId } from "../src/domain/primitives";
import type { CoreStatus, NextActor } from "../src/domain/records";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";

const RUN_ID = "10000000-0000-0000-0000-000000000001" as WorkflowRunId;

interface StageRow {
  readonly stage_instance_id: string;
  readonly name: string;
  readonly stage_type: string;
  readonly operator_role: string | null;
  readonly status: CoreStatus;
  readonly blocked_reason: "gate" | null;
  readonly next_actor: NextActor | null;
}

interface UnitRow {
  readonly cohort_id: string;
  readonly stage_instance_id: string;
  readonly unit_id: string;
  readonly params: null;
  readonly status: CoreStatus;
  readonly blocked_reason: "gate" | null;
  readonly next_actor: NextActor | null;
  readonly session_id: string | null;
  readonly gate_step: string | null;
}

interface ArtifactRow {
  readonly stage_instance_id: string;
  readonly id: string;
  readonly type_id: string;
  readonly version: number;
  readonly label: string | null;
  readonly created_at: string;
}

interface SessionRow {
  readonly session_id: string;
  readonly stage_key: string;
  readonly cohort_id: string;
  readonly attempt_number: number;
  readonly attempt_count: number;
  readonly status: CoreStatus;
  readonly created_at: string;
}

interface DiagnosisFixture {
  readonly stages?: readonly StageRow[];
  readonly units?: readonly UnitRow[];
  readonly artifacts?: readonly ArtifactRow[];
  readonly sessions?: readonly SessionRow[];
}

class DiagnosisSql implements TransactionalSqlExecutor {
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
      rows = this.fixture.units ?? [];
    } else if (statement.includes("FROM oakridge.artifact artifact JOIN oakridge.artifact_owner")) {
      rows = this.fixture.artifacts ?? [];
    } else if (statement.includes("SELECT definition.definition")) {
      rows = [];
    } else if (statement.includes("FROM oakridge.session session") && statement.includes("attempt_count")) {
      rows = this.fixture.sessions ?? [];
    } else if (statement.includes("FROM oakridge.wait_gate wait")) {
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

const stage = (index: number, status: CoreStatus): StageRow => ({
  stage_instance_id: `20000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
  name: `stage-${index}`,
  stage_type: "delegated_session",
  operator_role: null,
  status,
  blocked_reason: status === "blocked" ? "gate" : null,
  next_actor: status === "blocked" ? "operator" : status === "complete" || status === "failed" || status === "cancelled" ? null : "core",
});

const diagnosisOf = (fixture: DiagnosisFixture) =>
  new PostgresOperatorProjectionRepository(new DiagnosisSql(fixture), "test-app-version", createDevFlowAdapterRegistry())
    .get_run_diagnosis(RUN_ID);

describe("get_run_diagnosis", () => {
  test("current_session picks the newest executing attempt and never a superseded one", async () => {
    const build = stage(1, "active");
    const diagnosis = await diagnosisOf({ stages: [build], sessions: [
      { session_id: "sid-superseded", stage_key: "stage-1", cohort_id: "30000000-0000-0000-0000-000000000001", attempt_number: 1, attempt_count: 2, status: "complete", created_at: "2026-09-29T01:00:00Z" },
      { session_id: "sid-executing-older", stage_key: "stage-1", cohort_id: "30000000-0000-0000-0000-000000000002", attempt_number: 1, attempt_count: 1, status: "active", created_at: "2026-09-29T02:00:00Z" },
      { session_id: "sid-executing-newest", stage_key: "stage-1", cohort_id: "30000000-0000-0000-0000-000000000001", attempt_number: 2, attempt_count: 2, status: "active", created_at: "2026-09-29T03:00:00Z" },
    ] });

    expect(diagnosis?.current_session?.session_id).toBe("sid-executing-newest");
  });

  test("sessions_awaiting_action names only the current attempt of an operator-blocked cohort", async () => {
    const blocked = stage(1, "blocked");
    const agentBlocked = { ...stage(2, "blocked"), next_actor: "agent" as const };
    const operatorCohort = "30000000-0000-0000-0000-000000000001";
    const agentCohort = "30000000-0000-0000-0000-000000000002";
    const units: UnitRow[] = [
      { cohort_id: operatorCohort, stage_instance_id: blocked.stage_instance_id, unit_id: "operator", params: null, status: "blocked", blocked_reason: "gate", next_actor: "operator", session_id: "sid-current", gate_step: "review" },
      { cohort_id: agentCohort, stage_instance_id: agentBlocked.stage_instance_id, unit_id: "agent", params: null, status: "blocked", blocked_reason: "gate", next_actor: "agent", session_id: "sid-agent", gate_step: null },
    ];
    const diagnosis = await diagnosisOf({ stages: [blocked, agentBlocked], units, sessions: [
      { session_id: "sid-old", stage_key: blocked.name, cohort_id: operatorCohort, attempt_number: 1, attempt_count: 2, status: "complete", created_at: "2026-09-29T01:00:00Z" },
      { session_id: "sid-current", stage_key: blocked.name, cohort_id: operatorCohort, attempt_number: 2, attempt_count: 2, status: "blocked", created_at: "2026-09-29T02:00:00Z" },
      { session_id: "sid-agent", stage_key: agentBlocked.name, cohort_id: agentCohort, attempt_number: 1, attempt_count: 1, status: "blocked", created_at: "2026-09-29T03:00:00Z" },
    ] });

    expect(diagnosis?.sessions_awaiting_action.map(({ session_id }) => session_id)).toEqual(["sid-current"]);
  });

  test("recent_artifacts orders by instant across stages and caps at eight", async () => {
    const stages = [stage(1, "complete"), stage(2, "active")];
    const artifacts: ArtifactRow[] = Array.from({ length: 10 }, (_, index) => ({
      stage_instance_id: stages[index % 2]!.stage_instance_id,
      id: `40000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      type_id: "dev.result",
      version: index + 1,
      label: null,
      created_at: index === 8 ? "2026-11-01T01:30:00-04:00" : index === 9 ? "2026-11-01T01:15:00-05:00" : `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const diagnosis = await diagnosisOf({ stages, artifacts });

    expect(diagnosis?.recent_artifacts).toHaveLength(8);
    expect(diagnosis?.recent_artifacts.slice(0, 2).map(({ revision }) => revision)).toEqual([10, 9]);
    expect(diagnosis?.recent_artifacts.at(-1)?.revision).toBe(3);
  });

  test("stage_progress counts every CoreStatus", async () => {
    const statuses: CoreStatus[] = ["pending", "active", "blocked", "complete", "failed", "cancelled"];
    const diagnosis = await diagnosisOf({ stages: statuses.map((status, index) => stage(index + 1, status)) });

    expect(diagnosis?.stage_progress).toEqual({ total: 6, pending: 1, active: 1, blocked: 1, complete: 1, failed: 1, cancelled: 1 });
  });

  test("stage_progress reports zero for an empty run", async () => {
    const diagnosis = await diagnosisOf({ stages: [] });

    expect(diagnosis?.stage_progress).toEqual({ total: 0, pending: 0, active: 0, blocked: 0, complete: 0, failed: 0, cancelled: 0 });
  });
});
