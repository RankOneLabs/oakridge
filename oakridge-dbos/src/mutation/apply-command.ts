import type { DecisionOutcome, Trigger } from "../core-client/generated-contracts";
import type { CoreClient } from "../core-client/client";
import type { TransactionalSqlExecutor, SqlExecutor } from "../storage/sql-executor";
import { loadEvaluationSnapshot, type StorageResult } from "../storage/replacement-repositories";
import { loadTransition } from "./transitions";
import { latestScopeVersion, versionConflict, type ScopeId, type VersionConflict } from "./scope-version";
import type { CommittedResult, IngressConflict, IngressReceipt } from "./ingress-receipt";

export interface CommandRequest {
  readonly scope_id: ScopeId; readonly ingress_id: string; readonly digest: string;
  readonly expected_version: number; readonly trigger: Trigger;
}
export type CommandError = VersionConflict | IngressConflict |
  { readonly kind: "pending" | "unsupported_decision" | "evaluation_failed" | "storage_failed"; readonly detail: string };
export type CommandResult = { readonly ok: true; readonly value: CommittedResult } | { readonly ok: false; readonly error: CommandError };
export interface Evaluator { evaluate(input: Awaited<ReturnType<typeof loadEvaluationSnapshot>> extends StorageResult<infer T> ? T : never): Promise<StorageResult<DecisionOutcome>> }

export function coreEvaluator(core: CoreClient): Evaluator {
  return { async evaluate({ bundle, snapshot }) {
    const response = await core.request("evaluate", { bundle, snapshot, available_operations: bundle.operations });
    if (!response.ok) return { ok: false, error: { kind: "invalid", operation: "evaluate", entity_id: snapshot.owner, detail: JSON.stringify(response.error) } };
    if (response.value.kind !== "evaluated") return { ok: false, error: { kind: "invalid", operation: "evaluate", entity_id: snapshot.owner, detail: "unexpected core output" } };
    return { ok: true, value: response.value.value };
  } };
}

async function readReceipt(sql: SqlExecutor, request: CommandRequest): Promise<IngressReceipt | null> {
  const rows = await sql.query<IngressReceipt>(`SELECT scope_id,ingress_id,digest,trigger,expected_version,decision,result
    FROM oakridge_replacement.ingress_receipt WHERE scope_id=$1 AND ingress_id=$2`, [request.scope_id, request.ingress_id]);
  return rows[0] ?? null;
}
const failure = (kind: "pending" | "unsupported_decision" | "evaluation_failed" | "storage_failed", detail: string): CommandResult =>
  ({ ok: false, error: { kind, detail } });

/** The receipt transaction completes before the evaluator is called. */
export async function applyCommand(sql: TransactionalSqlExecutor, evaluator: Evaluator, request: CommandRequest,
  after_decision_saved?: () => Promise<void>): Promise<CommandResult> {
  try {
    const initial = await sql.transaction(async (tx): Promise<CommandResult | null> => {
      const previous = await readReceipt(tx, request);
      if (previous) {
        if (previous.digest !== request.digest) return { ok: false, error: { kind: "ingress_conflict", scope_id: request.scope_id, ingress_id: request.ingress_id } };
        if (previous.result) return { ok: true, value: previous.result };
        return null;
      }
      const actual = await latestScopeVersion(tx, request.scope_id);
      if (actual !== request.expected_version) return { ok: false, error: versionConflict(request.scope_id, request.expected_version, actual) };
      await tx.query(`INSERT INTO oakridge_replacement.ingress_receipt
        (scope_id,ingress_id,digest,trigger,expected_version) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (scope_id,ingress_id) DO NOTHING`,
        [request.scope_id, request.ingress_id, request.digest, JSON.stringify(request.trigger), request.expected_version]);
      return null;
    });
    if (initial) return initial;
    let receipt = await readReceipt(sql, request);
    if (!receipt) return failure("storage_failed", "receipt was not committed");
    if (receipt.result) return { ok: true, value: receipt.result };
    if (!receipt.decision) {
      const loaded = await sql.transaction((tx) => loadEvaluationSnapshot(tx, request.scope_id, receipt!.trigger));
      if (!loaded.ok) return failure("storage_failed", loaded.error.detail);
      if (loaded.value.snapshot.version !== receipt.expected_version)
        return { ok: false, error: versionConflict(request.scope_id, receipt.expected_version, loaded.value.snapshot.version) };
      const evaluated = await evaluator.evaluate(loaded.value);
      if (!evaluated.ok) return failure("evaluation_failed", evaluated.error.detail);
      await sql.query(`UPDATE oakridge_replacement.ingress_receipt SET decision=$3
        WHERE scope_id=$1 AND ingress_id=$2 AND decision IS NULL AND result IS NULL`,
        [request.scope_id, request.ingress_id, JSON.stringify(evaluated.value)]);
      receipt = await readReceipt(sql, request);
      if (!receipt) return failure("storage_failed", "receipt disappeared");
      await after_decision_saved?.();
    }
    const decision = receipt.decision;
    if (!decision) return failure("pending", "decision is being recorded");
    if (decision.kind !== "apply") return failure("unsupported_decision", `decision kind ${decision.kind} cannot be committed`);
    if (decision.mutations.some((mutation) => !["set_state", "export"].includes(mutation.kind)))
      return failure("unsupported_decision", "mutation is not supported by replacement commit");
    return await sql.transaction(async (tx): Promise<CommandResult> => {
      const current = await readReceipt(tx, request);
      if (current?.result) return { ok: true, value: current.result };
      // The scope row serializes writers only during commit; no lock spans evaluation.
      const owners = await tx.query<{ readonly id: string; readonly terminal_outcome: unknown | null }>(
        "SELECT id,terminal_outcome FROM oakridge_replacement.scope_instance WHERE id=$1 FOR UPDATE", [request.scope_id]);
      if (!owners.length) return failure("storage_failed", "scope missing");
      if (owners[0]!.terminal_outcome !== null) return failure("unsupported_decision", "scope is terminal");
      const actual = await latestScopeVersion(tx, request.scope_id);
      if (actual !== request.expected_version) return { ok: false, error: versionConflict(request.scope_id, request.expected_version, actual) };
      const previous = await loadTransition(tx, request.scope_id);
      if (!previous) return failure("storage_failed", "genesis transition missing");
      let local_value = previous.local_value;
      for (const mutation of decision.mutations) {
        if (mutation.kind === "set_state") local_value = mutation.value;
        if (mutation.kind === "export") await tx.query(`INSERT INTO oakridge_replacement.scope_export(scope_id,key,value,version)
          VALUES ($1,$2,$3,$4) ON CONFLICT (scope_id,key) DO UPDATE SET value=EXCLUDED.value,version=EXCLUDED.version`,
          [request.scope_id, mutation.key, JSON.stringify(mutation.value), actual + 1]);
      }
      const fact_id = crypto.randomUUID();
      const transition_id = crypto.randomUUID();
      await tx.query(`INSERT INTO oakridge_replacement.fact(id,scope_id,trigger_key,payload) VALUES ($1,$2,$3,$4)`,
        [fact_id, request.scope_id, request.trigger.key, JSON.stringify(request.trigger.payload)]);
      await tx.query(`INSERT INTO oakridge_replacement.transition
        (id,scope_id,version,decision,read_set,changes,causal_fact_id,local_value)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [transition_id, request.scope_id, actual + 1, JSON.stringify(decision), JSON.stringify(decision.explanation.read_set),
          JSON.stringify(decision.mutations), fact_id, JSON.stringify(local_value)]);
      if (decision.outcome) await tx.query(`UPDATE oakridge_replacement.scope_instance SET terminal_outcome=$2
        WHERE id=$1 AND terminal_outcome IS NULL`, [request.scope_id, JSON.stringify(decision.outcome)]);
      for (const invocation of decision.invocations) await tx.query(`INSERT INTO oakridge_replacement.effect_intent
        (id,scope_id,transition_id,payload,delivery) VALUES ($1,$2,$3,$4,$5)`,
        [crypto.randomUUID(), request.scope_id, transition_id, JSON.stringify(invocation), JSON.stringify({ kind: "pending" })]);
      const result: CommittedResult = { kind: "committed", transition_id, version: actual + 1 };
      await tx.query(`UPDATE oakridge_replacement.ingress_receipt SET result=$3 WHERE scope_id=$1 AND ingress_id=$2`,
        [request.scope_id, request.ingress_id, JSON.stringify(result)]);
      return { ok: true, value: result };
    });
  } catch (cause) { return failure("storage_failed", String(cause)); }
}
