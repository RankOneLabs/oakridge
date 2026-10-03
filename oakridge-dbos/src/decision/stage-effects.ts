import { attemptIdFor, sessionIdFor, stageGateCommandWorkflowId, stageGateIdFor } from "./ids";
import type { CompiledStageContract } from "../domain/compiled-workflow";
import { err, ok, type CohortId, type JsonValue, type Result, type RunTransitionId, type StageInstanceId, type WorkflowRunId } from "../domain/primitives";
import type { EffectRef, JsonObject, StageEvent } from "../domain/stage-machine";
import { abandonCohortAttempts } from "../storage/postgres-run-record";
import type { SqlExecutor } from "../storage/sql-executor";

export interface CohortEffectRow {
  readonly id: CohortId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly round: number;
  readonly stage_data: JsonValue;
  readonly stage_contract: CompiledStageContract;
}

export interface EffectError {
  readonly operation: "stage_effect";
  readonly effect: string;
  readonly cohort_id: CohortId;
  readonly detail: string;
}

export type RegisteredEffect = (tx: SqlExecutor, input: {
  readonly cohort: CohortEffectRow;
  readonly event: StageEvent;
  readonly args: JsonObject;
}) => Promise<Result<{ readonly stage_data: JsonValue | null }, EffectError>>;

export interface StageEffectContext {
  readonly cohort: CohortEffectRow;
  readonly event: StageEvent;
  readonly transition_id: RunTransitionId;
  readonly at: string;
}

export interface StageEffectsResult {
  readonly stage_data: JsonValue | null;
  readonly has_external_effects: boolean;
}

const coreNames = new Set(["launch_session", "end_session", "record_output", "open_gate", "accept_outputs", "new_round"]);
export const isCoreStageEffect = (name: string): boolean => coreNames.has(name);

const stringArg = (args: JsonObject, key: string): string | null => typeof args[key] === "string" ? args[key] as string : null;
const stringListArg = (args: JsonObject, key: string): readonly string[] | null =>
  Array.isArray(args[key]) && (args[key] as readonly JsonValue[]).every((value) => typeof value === "string")
    ? args[key] as readonly string[] : null;

const outputRows = async (tx: SqlExecutor, cohort: CohortEffectRow, outputs: readonly string[]) =>
  tx.query<{ readonly artifact_id: string; readonly output_name: string; readonly collection_key: string | null; readonly artifact_type: string }>(
    `SELECT output.artifact_id::text,output.output_name,output.collection_key,artifact.artifact_type
     FROM oakridge.cohort_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
     WHERE output.cohort_id=$1 AND output.round=$2 AND output.output_name=ANY($3::text[])
     ORDER BY output.output_name,output.collection_key NULLS FIRST`, [cohort.id, cohort.round, outputs]);

const launchSession = async (tx: SqlExecutor, context: StageEffectContext, args: JsonObject): Promise<Result<void, EffectError>> => {
  const role = stringArg(args, "role");
  const reason = stringArg(args, "reason");
  if (!role || !reason) return err({ operation: "stage_effect", effect: "launch_session", cohort_id: context.cohort.id,
    detail: "role and reason are required" });
  const worker = role === "assessor" || role === "assessment" ? "assessment" : "build";
  const rows = await tx.query<{ readonly attempt_number: number }>(
    "SELECT COALESCE(MAX(attempt_number),0)+1 AS attempt_number FROM oakridge.attempt WHERE cohort_id=$1 AND worker=$2",
    [context.cohort.id, worker]);
  const attempt_number = rows[0]?.attempt_number ?? 1;
  const attempt_id = attemptIdFor(context.cohort.id, attempt_number, worker);
  const session_id = sessionIdFor(attempt_id);
  await abandonCohortAttempts(tx, { cohort_id: context.cohort.id, worker, at: context.at, reason: "replaced_by_launch" });
  await tx.query(
    `INSERT INTO oakridge.attempt
       (id,run_id,stage_instance_id,cohort_id,worker,attempt_number,adapter_type,request,idempotency_key,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9::timestamptz)`,
    [attempt_id, context.cohort.run_id, context.cohort.stage_instance_id, context.cohort.id, worker, attempt_number,
      context.cohort.stage_contract.executor.executor_type,
      context.event.kind === "operator_retry" ? context.event.idempotency_key : null, context.at]);
  await tx.query(
    `INSERT INTO oakridge.session
       (id,run_id,stage_instance_id,attempt_id,launch_transition_id,adapter_reference,created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)`,
    [session_id, context.cohort.run_id, context.cohort.stage_instance_id, attempt_id,
      context.transition_id, JSON.stringify({ kind: "none", role, reason }), context.at]);
  return ok(undefined);
};

const recordOutput = async (tx: SqlExecutor, context: StageEffectContext): Promise<Result<void, EffectError>> => {
  if (context.event.kind !== "artifact_published") return err({ operation: "stage_effect", effect: "record_output",
    cohort_id: context.cohort.id, detail: "record_output requires artifact_published" });
  await tx.query(
    `INSERT INTO oakridge.cohort_output (cohort_id,round,output_name,collection_key,artifact_id,recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz)
     ON CONFLICT (cohort_id,round,output_name,collection_key)
     DO UPDATE SET artifact_id=EXCLUDED.artifact_id,recorded_at=EXCLUDED.recorded_at`,
    [context.cohort.id, context.cohort.round, context.event.output, context.event.collection_key,
      context.event.artifact_id, context.at]);
  return ok(undefined);
};

const openGate = async (tx: SqlExecutor, context: StageEffectContext, args: JsonObject): Promise<Result<void, EffectError>> => {
  const gate = stringArg(args, "gate");
  const outputs = stringListArg(args, "outputs");
  if (!gate || !outputs) return err({ operation: "stage_effect", effect: "open_gate", cohort_id: context.cohort.id,
    detail: "gate and outputs are required" });
  const declared = context.cohort.stage_contract.outputs.find((output) =>
    output.release.kind === "gate" && output.release.gate_name === gate);
  if (!declared || declared.release.kind !== "gate") return err({ operation: "stage_effect", effect: "open_gate",
    cohort_id: context.cohort.id, detail: `gate '${gate}' is not declared` });
  const artifacts = await outputRows(tx, context.cohort, outputs);
  if (artifacts.length === 0) return err({ operation: "stage_effect", effect: "open_gate",
    cohort_id: context.cohort.id, detail: `gate '${gate}' has no outputs` });
  const gate_id = stageGateIdFor(context.cohort.id, gate, context.cohort.round);
  const actions = declared.release.steps.flatMap((step) => step.actions.map((action) => action.name));
  await tx.query(
    `INSERT INTO oakridge.wait_gate
       (id,run_id,stage_instance_id,cohort_id,kind,closes_on,command_workflow_id,opened_at)
     VALUES ($1,$2,$3,$4,'gate',$5::jsonb,$6,$7::timestamptz)
     ON CONFLICT (id) DO NOTHING`,
    [gate_id, context.cohort.run_id, context.cohort.stage_instance_id, context.cohort.id,
      JSON.stringify({ actions }), stageGateCommandWorkflowId(context.cohort.id, gate, context.cohort.round), context.at]);
  for (const artifact of artifacts) await tx.query(
    `INSERT INTO oakridge.wait_gate_artifact_revision (wait_gate_id,artifact_id,run_id)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [gate_id, artifact.artifact_id, context.cohort.run_id]);
  return ok(undefined);
};

const acceptOutputs = async (tx: SqlExecutor, context: StageEffectContext, args: JsonObject): Promise<Result<void, EffectError>> => {
  const outputs = stringListArg(args, "outputs");
  if (!outputs) return err({ operation: "stage_effect", effect: "accept_outputs",
    cohort_id: context.cohort.id, detail: "outputs must be a list" });
  for (const output of await outputRows(tx, context.cohort, outputs)) {
    await tx.query(
      `INSERT INTO oakridge.artifact_acceptance
         (artifact_id,run_id,cohort_id,receiving_stage_instance_id,output_name,artifact_type,collection_key,accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)
       ON CONFLICT (artifact_id) DO NOTHING`,
      [output.artifact_id, context.cohort.run_id, context.cohort.id, context.cohort.stage_instance_id,
        output.output_name, output.artifact_type, output.collection_key, context.at]);
    await tx.query("UPDATE oakridge.artifact SET lifecycle='released' WHERE id=$1", [output.artifact_id]);
  }
  return ok(undefined);
};

const newRound = async (tx: SqlExecutor, context: StageEffectContext): Promise<void> => {
  await tx.query("UPDATE oakridge.cohort SET round=round+1 WHERE id=$1", [context.cohort.id]);
  await tx.query(
    `UPDATE oakridge.artifact SET lifecycle='superseded'
     WHERE id IN (SELECT artifact_id FROM oakridge.cohort_output WHERE cohort_id=$1 AND round<=$2)`,
    [context.cohort.id, context.cohort.round]);
  await tx.query(
    `UPDATE oakridge.artifact_acceptance SET superseded_at=$3::timestamptz
     WHERE artifact_id IN (SELECT artifact_id FROM oakridge.cohort_output WHERE cohort_id=$1 AND round<=$2)
       AND superseded_at IS NULL`, [context.cohort.id, context.cohort.round, context.at]);
};

export const runStageEffectsIn = async (tx: SqlExecutor, context: StageEffectContext,
  effects: readonly EffectRef[], registered: ReadonlyMap<string, RegisteredEffect>): Promise<Result<StageEffectsResult, EffectError>> => {
  let stage_data: JsonValue | null = null;
  let has_external_effects = false;
  for (const effect of effects) {
    const name = effect.name as string;
    if (name === "launch_session") {
      const launched = await launchSession(tx, context, effect.args);
      if (!launched.ok) return launched;
      has_external_effects = true;
    } else if (name === "end_session") {
      has_external_effects = true;
    } else if (name === "record_output") {
      const recorded = await recordOutput(tx, context);
      if (!recorded.ok) return recorded;
    } else if (name === "open_gate") {
      const opened = await openGate(tx, context, effect.args);
      if (!opened.ok) return opened;
    } else if (name === "accept_outputs") {
      const accepted = await acceptOutputs(tx, context, effect.args);
      if (!accepted.ok) return accepted;
    } else if (name === "new_round") {
      await newRound(tx, context);
    } else {
      const handler = registered.get(`${context.cohort.stage_contract.stage_type}:${name}`);
      if (!handler) return err({ operation: "stage_effect", effect: name, cohort_id: context.cohort.id,
        detail: "effect is not registered" });
      const result = await handler(tx, { cohort: context.cohort, event: context.event, args: effect.args });
      if (!result.ok) return result;
      if (result.value.stage_data !== null) stage_data = result.value.stage_data;
    }
  }
  return ok({ stage_data, has_external_effects });
};
