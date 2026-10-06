import type { TransactionalSqlExecutor } from "./sql-executor";
import type { CoreClient } from "../core-client/client";
import { createMutationService } from "./mutation-service";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { RunId, ScopeId } from "./schema-records";
import { hydrate, type DeleteEligibility } from "../effects/reconcile";
import { pendingCleanupCount, requiresCleanup, type EffectPayload, type EffectStatus } from "../effects/leases";

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
      const transactional: TransactionalSqlExecutor = { query: tx.query.bind(tx), transaction: (operation) => operation(tx) };
      const mutations = createMutationService(transactional, core);
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
        const schema = bundle.schemas.find((schema) => schema.key === trigger.payload_schema);
        const provided = command.payloads?.find((item) => item.scope_id === scope.id);
        const payload = provided ? provided.payload : schema?.shape.kind === "string" ? command.reason : {};
        const checked = await core.request("validate_payload", { bundle, available_operations: bundle.operations, schema: trigger.payload_schema, payload });
        if (!checked.ok || checked.value.kind !== "validated") throw new InvalidCancellation(`invalid cancellation payload for ${scope.scope_key}`);
        const outcome = await mutations.decide({ run_id: command.run_id as RunId, scope_id: scope.id, ingress_id: `cancel:${scope.id}`,
          trigger: { id: `cancel:${scope.id}`, key, payload: checked.value.value }, operator_version: null });
        if (!outcome.ok || (outcome.value.kind !== "Committed" && outcome.value.kind !== "Replayed")) throw new InvalidCancellation(`configured cancellation was not committed for ${scope.scope_key}`);
      }
    }
    await hydrate(tx, command.run_id);
    await tx.query(`UPDATE authority.execution_selection SET execution_id=NULL,generation=generation+1,version=version+1
      WHERE scope_id IN (SELECT id FROM authority.scope_instance WHERE run_id=$1) AND execution_id IS NOT NULL`, [command.run_id]);
    const starts = await tx.query<{ id: string; scope_id: string; execution_id: string | null; effect_key: string; payload: EffectPayload; status: EffectStatus }>(`SELECT e.* FROM authority.effect_intent e
      JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 AND e.payload->>'action'='start'
      FOR UPDATE OF e`, [command.run_id]);
    let stop_intents = 0;
    for (const start of starts) {
      const needs_cleanup = requiresCleanup(start);
      // A claim already in flight can still create an external process. Its
      // completion is fenced by the row version, while this stop survives it.
      if (start.status === "pending" || start.status === "in_flight" || start.status === "uncertain")
        await tx.query("UPDATE authority.effect_intent SET status='revoked',payload=CASE WHEN status IN ('in_flight','uncertain') THEN jsonb_set(payload,'{has_uncertain_start}','true') ELSE payload END,version=version+1 WHERE id=$1", [start.id]);
      if (!needs_cleanup) continue;
      stop_intents++;
      const payload: EffectPayload = { invocation: start.payload.invocation, action: "stop", handle: start.payload.handle ?? null };
      await tx.query(`INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload,status)
        VALUES ($1,$2,$3,$4,$5,'cleanup_pending') ON CONFLICT (scope_id,effect_key) DO NOTHING`,
      [crypto.randomUUID(), start.scope_id, start.execution_id, `${start.effect_key}:stop`, JSON.stringify(payload)]);
    }
    return { kind: "cancelled", stop_intents };
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
    await hydrate(tx, run_id);
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
