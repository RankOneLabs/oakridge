import { inTransaction, type TransactionalSqlExecutor } from "./sql-executor";
import type { CoreClient } from "../core-client/client";
import { createMutationService } from "./mutation-service";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { RunId, ScopeId } from "./schema-records";
import { pendingCleanupCount, type DeleteEligibility } from "../effects/intents";
import { revokeStarts } from "./revocation";
import { prepareLifecycleTrigger } from "./lifecycle-trigger";

export interface ScopeCancellationPayload { readonly scope_id: ScopeId; readonly payload: unknown }
export interface CancelRunCommand { readonly kind: "cancel_run"; readonly run_id: string; readonly reason: string; readonly payloads?: readonly ScopeCancellationPayload[] }
export type CancelRunResult = { readonly kind: "cancelled"; readonly stop_intents: number } | { readonly kind: "missing" } | { readonly kind: "rejected"; readonly detail: string };

/** Revoke authority and retain a stop identity for every selected start in one transaction. */
class InvalidCancellation extends Error {}

export async function cancelRun(db: TransactionalSqlExecutor, command: CancelRunCommand, core?: CoreClient): Promise<CancelRunResult> {
  try { return await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [command.run_id]);
    const runs = await tx.query<{ id: string }>("SELECT id FROM authority.run WHERE id=$1 FOR UPDATE", [command.run_id]);
    if (!runs.length) return { kind: "missing" };
    if (core) {
      const mutations = createMutationService(inTransaction(tx), core);
      const bundles = await tx.query<{ source: DefinitionBundle }>("SELECT b.source FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [command.run_id]);
      const bundle = bundles[0]?.source;
      if (!bundle) throw new InvalidCancellation("cancellation definition bundle missing");
      const scopes = await tx.query<{ id: ScopeId; scope_key: string; is_terminal: boolean }>(`WITH RECURSIVE descendants AS (
        SELECT id,scope_key,is_terminal,0 AS depth FROM authority.scope_instance WHERE run_id=$1 AND parent_id IS NULL
        UNION ALL SELECT s.id,s.scope_key,s.is_terminal,d.depth+1 FROM authority.scope_instance s JOIN descendants d ON s.parent_id=d.id
      ) SELECT * FROM descendants ORDER BY depth DESC,id`, [command.run_id]);
      const provided_ids = command.payloads?.map((item) => item.scope_id) ?? [];
      if (new Set(provided_ids).size !== provided_ids.length || provided_ids.some((id) => !scopes.some((scope) => scope.id === id))) throw new InvalidCancellation("cancellation payloads must target distinct scopes in this run");
      for (const scope of scopes) {
        if (scope.is_terminal) continue;
        const definition = bundle.scopes.find((item) => item.key === scope.scope_key);
        const key = definition?.cancellation.trigger;
        const trigger = definition?.commands.find((item) => item.key === key) ?? definition?.facts.find((item) => item.key === key);
        if (!definition || !key || !trigger) throw new InvalidCancellation(`cancellation trigger missing for ${scope.scope_key}`);
        const provided = command.payloads?.find((item) => item.scope_id === scope.id);
        const prepared = await prepareLifecycleTrigger({ core, bundle, id: `cancel:${scope.id}`, key, schema: trigger.payload_schema,
          projection: definition.cancellation.payload, reason: command.reason,
          has_supplied_payload: provided !== undefined, supplied_payload: provided?.payload });
        if (!prepared.ok) throw new InvalidCancellation(`invalid cancellation payload for ${scope.scope_key}: ${prepared.error.detail}`);
        const outcome = await mutations.decide({ run_id: command.run_id as RunId, scope_id: scope.id, ingress_id: `cancel:${scope.id}`,
          trigger: prepared.value, operator_version: null });
        if (!outcome.ok || (outcome.value.kind !== "Committed" && outcome.value.kind !== "Replayed")) throw new InvalidCancellation(`configured cancellation was not committed for ${scope.scope_key}`);
      }
    }
    await tx.query(`UPDATE authority.execution_selection SET execution_id=NULL,generation=generation+1,version=version+1
      WHERE scope_id IN (SELECT id FROM authority.scope_instance WHERE run_id=$1) AND execution_id IS NOT NULL`, [command.run_id]);
    // A start already in flight can still create an external process; its stop intent survives it.
    const owned = await tx.query<{ id: string }>("SELECT id FROM authority.scope_instance WHERE run_id=$1", [command.run_id]);
    const stops = await revokeStarts(tx, owned.map((scope) => scope.id), null);
    return { kind: "cancelled", stop_intents: stops.length };
  }); } catch (error) {
    if (error instanceof InvalidCancellation) return { kind: "rejected", detail: error.message };
    throw error;
  }
}


export type DeleteRunResult = DeleteEligibility | { readonly kind: "deleted" } | { readonly kind: "missing" };

export async function deleteRun(db: TransactionalSqlExecutor, run_id: string): Promise<DeleteRunResult> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [run_id]);
    const runs = await tx.query<{ id: string }>("SELECT id FROM authority.run WHERE id=$1 FOR UPDATE", [run_id]);
    if (!runs.length) return { kind: "missing" };
    const obligations = await pendingCleanupCount(tx, run_id);
    if (obligations) return { kind: "refused", obligations };
    const scopeIds = "SELECT id FROM authority.scope_instance WHERE run_id=$1";
    for (const table of ["ingress_receipt", "effect_intent", "resource_binding", "capacity_reservation", "fact", "transition", "output_slot", "artifact_revision", "execution_selection", "execution", "scope_export", "child_collection"])
      await tx.query(`DELETE FROM authority.${table} WHERE scope_id IN (${scopeIds})`, [run_id]);
    await tx.query("DELETE FROM authority.capacity_pool WHERE run_id=$1", [run_id]);
    await tx.query("DELETE FROM authority.scope_instance WHERE run_id=$1", [run_id]);
    await tx.query("DELETE FROM authority.run WHERE id=$1", [run_id]);
    return { kind: "deleted" };
  });
}

interface RunGenerationRow { readonly current_generation: string | number; readonly current_cursor: string | null }
export interface RunAddress { readonly generation: number; readonly cursor: string | null }
export async function currentRunAddress(db: TransactionalSqlExecutor, run_id: string): Promise<RunAddress | null> {
  const rows = await db.query<RunGenerationRow>("SELECT current_generation,current_cursor FROM authority.run WHERE id=$1", [run_id]);
  return rows[0] ? { generation: Number(rows[0].current_generation), cursor: rows[0].current_cursor ?? null } : null;
}
/** The authority row is the address book for rollover and recovery. */
export async function currentRunGeneration(db: TransactionalSqlExecutor, run_id: string): Promise<number | null> {
  return (await currentRunAddress(db, run_id))?.generation ?? null;
}
/** Claim a successor only while the caller still owns the current generation. */
export async function claimRunGeneration(db: TransactionalSqlExecutor, run_id: string, expected: number, cursor?: string | null): Promise<number | null> {
  const rows = await db.query<RunGenerationRow>(`UPDATE authority.run SET current_generation=current_generation+1,
    current_cursor=CASE WHEN $3::boolean THEN $4 ELSE current_cursor END
    WHERE id=$1 AND current_generation=$2 RETURNING current_generation,current_cursor`, [run_id, expected, cursor !== undefined, cursor ?? null]);
  return rows[0] ? Number(rows[0].current_generation) : null;
}
