import { randomUUID } from "node:crypto";

import type { ArtifactId, StageInstanceId, UnitId, WaitId } from "../domain/primitives";
import type { CloseWaitRequest, OpenGateWaitInput, OpenHandoffDownstreamWaitInput, Wait, WaitClosesOn, WaitKind, WaitOutcome } from "../domain/wait";
import type { WaitRepository } from "./repositories";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

interface WaitRow {
  readonly id: string;
  readonly stage_instance_id: string;
  readonly unit_id: string;
  readonly artifact_revision_id: string;
  readonly closes_on: WaitClosesOn;
  readonly status: "open" | "closed";
  readonly outcome: WaitOutcome | null;
  readonly execution_workflow_id: string;
  readonly command_workflow_id: string;
  readonly opened_at: string;
  readonly closed_at: string | null;
}

const waitColumns = `wait.id::text, wait.stage_instance_id::text, wait.unit_id, wait.artifact_revision_id::text,
       wait.closes_on, wait.status, wait.outcome, wait.execution_workflow_id, wait.command_workflow_id,
       wait.opened_at::text, wait.closed_at::text`;

const decodeWait = (row: WaitRow): Wait => {
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
    execution_workflow_id: row.execution_workflow_id,
    command_workflow_id: row.command_workflow_id,
    opened_at: row.opened_at,
  };
};

interface OpenWaitColumns {
  readonly command_workflow_id: string;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly artifact_revision_id: ArtifactId;
  readonly execution_workflow_id: string;
}

export class PostgresWaitRepository implements WaitRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async open_gate(input: OpenGateWaitInput): Promise<void> {
    await this.insertOpen(this.sql, input, "gate", { kind: "gate", gate_step: input.gate_step, actions: input.actions });
  }

  async open_handoff_downstream(input: OpenHandoffDownstreamWaitInput): Promise<void> {
    await this.insertOpen(this.sql, input, "handoff_downstream", { kind: "handoff_downstream", downstream_role: input.downstream_role });
  }

  async close(command_workflow_id: string, request: CloseWaitRequest): Promise<void> {
    const rows = await this.sql.query<{ readonly id: string }>(
      `UPDATE oakridge.wait SET status = 'closed', outcome = $3::jsonb, closed_at = $4::timestamptz
       WHERE command_workflow_id = $1 AND kind = $2 AND status = 'open'
       RETURNING id::text`,
      [command_workflow_id, request.kind, JSON.stringify(request.outcome), new Date().toISOString()],
    );
    if (rows.length === 0) await this.requireCloseAbsorbed(this.sql, command_workflow_id, request.kind, request.outcome);
  }

  async release_downstream(
    command_workflow_id: string,
    decided_outcome: Extract<WaitOutcome, { kind: "decided" }>,
    external_closes_on: Extract<WaitClosesOn, { kind: "handoff_external" }>,
  ): Promise<void> {
    // One transaction: a reader in a gap between the downstream close and the
    // external open would derive `revision_requested` for a released handoff.
    await this.sql.transaction(async (transaction) => {
      const closed = await transaction.query<{ readonly stage_instance_id: string; readonly unit_id: string; readonly artifact_revision_id: string; readonly execution_workflow_id: string }>(
        `UPDATE oakridge.wait SET status = 'closed', outcome = $2::jsonb, closed_at = $3::timestamptz
         WHERE command_workflow_id = $1 AND kind = 'handoff_downstream' AND status = 'open'
         RETURNING stage_instance_id::text, unit_id, artifact_revision_id::text, execution_workflow_id`,
        [command_workflow_id, JSON.stringify(decided_outcome), new Date().toISOString()],
      );
      const downstream = closed[0] ?? await this.requireCloseAbsorbed(transaction, command_workflow_id, "handoff_downstream", decided_outcome);
      await this.insertOpen(transaction, {
        command_workflow_id,
        stage_instance_id: downstream.stage_instance_id as StageInstanceId,
        unit_id: downstream.unit_id as UnitId,
        artifact_revision_id: downstream.artifact_revision_id as ArtifactId,
        execution_workflow_id: downstream.execution_workflow_id,
      }, "handoff_external", external_closes_on);
    });
  }

  async find_gate_wait(artifact_revision_id: ArtifactId, gate_step: string, execution_workflow_id: string): Promise<Wait | null> {
    const rows = await this.sql.query<WaitRow>(
      `SELECT ${waitColumns} FROM oakridge.wait wait
       WHERE wait.artifact_revision_id = $1 AND wait.kind = 'gate'
         AND wait.closes_on->>'gate_step' = $2 AND wait.execution_workflow_id = $3
       ORDER BY wait.opened_at DESC LIMIT 1`,
      [artifact_revision_id, gate_step, execution_workflow_id],
    );
    const row = rows[0];
    return row ? decodeWait(row) : null;
  }

  async find_handoff_waits(artifact_revision_id: ArtifactId, execution_workflow_id: string): Promise<readonly Wait[]> {
    const rows = await this.sql.query<WaitRow>(
      `SELECT ${waitColumns} FROM oakridge.wait wait
       WHERE wait.artifact_revision_id = $1 AND wait.kind IN ('handoff_downstream', 'handoff_external')
         AND wait.execution_workflow_id = $2
       ORDER BY wait.opened_at DESC`,
      [artifact_revision_id, execution_workflow_id],
    );
    return rows.map(decodeWait);
  }

  async find_handoff_waits_for_artifact(artifact_revision_id: ArtifactId): Promise<readonly Wait[]> {
    const rows = await this.sql.query<WaitRow>(
      `SELECT ${waitColumns} FROM oakridge.wait wait
       WHERE wait.artifact_revision_id = $1 AND wait.kind IN ('handoff_downstream', 'handoff_external')
       ORDER BY wait.opened_at DESC`,
      [artifact_revision_id],
    );
    return rows.map(decodeWait);
  }

  async count_open_waits(command_workflow_id: string): Promise<number> {
    const rows = await this.sql.query<{ readonly open_count: string }>(
      `SELECT count(*)::text AS open_count FROM oakridge.wait
       WHERE command_workflow_id = $1 AND status = 'open'`,
      [command_workflow_id],
    );
    return Number(rows[0]?.open_count ?? 0);
  }

  async close_orphaned(command_workflow_id: string, at: string): Promise<void> {
    await this.sql.query(
      `UPDATE oakridge.wait SET status = 'closed', outcome = '{"kind":"withdrawn"}', closed_at = $2::timestamptz
       WHERE command_workflow_id = $1 AND status = 'open'`,
      [command_workflow_id, at],
    );
  }

  /**
   * A close that matched no open row is one of three things: a crash-retry
   * replaying a close that already committed — absorbed, preserving the row's
   * original `outcome` and `closed_at` — or a close of a row another path
   * already closed under a different outcome, or a close with no row at all.
   * The latter two are record corruption, surfaced loudly.
   */
  private async requireCloseAbsorbed(
    sql: SqlExecutor,
    command_workflow_id: string,
    kind: WaitKind,
    outcome: WaitOutcome,
  ): Promise<{ readonly stage_instance_id: string; readonly unit_id: string; readonly artifact_revision_id: string; readonly execution_workflow_id: string }> {
    const rows = await sql.query<{ readonly outcome_matches: boolean; readonly stage_instance_id: string; readonly unit_id: string; readonly artifact_revision_id: string; readonly execution_workflow_id: string }>(
      `SELECT outcome IS NOT DISTINCT FROM $3::jsonb AS outcome_matches,
              stage_instance_id::text, unit_id, artifact_revision_id::text, execution_workflow_id
       FROM oakridge.wait WHERE command_workflow_id = $1 AND kind = $2`,
      [command_workflow_id, kind, JSON.stringify(outcome)],
    );
    const row = rows[0];
    if (!row) throw new Error(`no '${kind}' wait is recorded for workflow '${command_workflow_id}'`);
    if (!row.outcome_matches) throw new Error(`'${kind}' wait for workflow '${command_workflow_id}' is already closed under a different outcome`);
    return row;
  }

  /**
   * `ON CONFLICT` names its arbiter rather than a bare `DO NOTHING`: a retried
   * open must be absorbed on (command_workflow_id, kind), while a collision on
   * `wait_open_identity` — a second workflow opening a wait another workflow
   * already holds open — must stay a loud failure.
   */
  private async insertOpen(sql: SqlExecutor, wait: OpenWaitColumns, kind: WaitKind, closes_on: WaitClosesOn): Promise<void> {
    await sql.query(
      `INSERT INTO oakridge.wait
         (id, stage_instance_id, unit_id, kind, artifact_revision_id, closes_on, status, execution_workflow_id, command_workflow_id, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'open', $7, $8, $9::timestamptz)
       ON CONFLICT (command_workflow_id, kind) DO NOTHING`,
      [randomUUID(), wait.stage_instance_id, wait.unit_id, kind, wait.artifact_revision_id, JSON.stringify(closes_on), wait.execution_workflow_id, wait.command_workflow_id, new Date().toISOString()],
    );
  }
}
