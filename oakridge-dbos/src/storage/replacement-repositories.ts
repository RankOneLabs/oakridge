import type { CheckedValue, DefinitionBundle, Snapshot, Trigger } from "../core-client/generated-contracts";
import type { SqlExecutor } from "./sql-executor";
import { loadTransition } from "../mutation/transitions";
import type { ScopeId } from "../mutation/scope-version";

export type StorageResult<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: StorageError };
export interface StorageError { readonly kind: "missing" | "storage" | "invalid"; readonly operation: string; readonly entity_id: string; readonly detail: string }
export interface EvaluationSnapshot { readonly bundle: DefinitionBundle; readonly snapshot: Snapshot }
interface ScopeRow { readonly id: ScopeId; readonly template_key: string; readonly input: CheckedValue; readonly bundle_digest: string; readonly checked_bundle: DefinitionBundle }

export async function loadEvaluationSnapshot(sql: SqlExecutor, scope_id: ScopeId, trigger: Trigger): Promise<StorageResult<EvaluationSnapshot>> {
  try {
    const rows = await sql.query<ScopeRow>(`SELECT s.id,s.template_key,s.input,b.digest AS bundle_digest,b.checked_bundle
      FROM oakridge_replacement.scope_instance s
      JOIN oakridge_replacement.run r ON r.id=s.run_id
      JOIN oakridge_replacement.definition_bundle b ON b.digest=r.bundle_digest WHERE s.id=$1`, [scope_id]);
    const scope = rows[0];
    if (!scope) return { ok: false, error: { kind: "missing", operation: "load_evaluation_snapshot", entity_id: scope_id, detail: "scope missing" } };
    const position = await loadTransition(sql, scope_id);
    if (!position) return { ok: false, error: { kind: "missing", operation: "load_evaluation_snapshot", entity_id: scope_id, detail: "genesis transition missing" } };
    return { ok: true, value: { bundle: scope.checked_bundle, snapshot: {
      owner: scope_id, scope: scope.template_key, input: scope.input, state: position.local_value,
      version: position.version, trigger, observations: [], random_seed: 0, timestamp_ms: Date.now(),
    } } };
  } catch (cause) {
    return { ok: false, error: { kind: "storage", operation: "load_evaluation_snapshot", entity_id: scope_id, detail: String(cause) } };
  }
}
