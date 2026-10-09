import type { Hono } from "hono";
import type { CoreClient } from "../core-client/client";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { EffectPayload } from "../effects/intents";
import type { MutationService } from "../storage/mutation-service";
import { findReceipt, requestDigest } from "../storage/receipts";
import type { RunId, ScopeId } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { hasExecutionSecret } from "./selected-publication";
import { publicationReceipt } from "./publication";

interface EvidenceDependencies { readonly db: TransactionalSqlExecutor; readonly core: CoreClient; readonly mutations: MutationService; readonly wake: (run_id: RunId) => Promise<void> }
interface SelectedEvidence { readonly source: DefinitionBundle; readonly scope_key: string; readonly payload: EffectPayload }

/** Only facts named by the selected action's evidence contract may be supplied by a worker. */
export function installSelectedEvidenceApi(app: Hono, deps: EvidenceDependencies): void {
  app.post("/api/runs/:run_id/scopes/:scope_id/executions/:execution_id/facts/:fact_key", async (c) => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    if (!raw || typeof raw !== "object" || !("request_id" in raw) || typeof raw.request_id !== "string" || !raw.request_id || !("payload" in raw))
      return c.json({ error: "request_id and payload are required" }, 400);
    const run_id = c.req.param("run_id") as RunId;
    const scope_id = c.req.param("scope_id") as ScopeId;
    const execution_id = c.req.param("execution_id");
    if (!await hasExecutionSecret(deps.db, run_id, scope_id, execution_id, c.req.header("authorization"))) return c.json({ error: "execution_authority_refused" }, 403);
    const key = c.req.param("fact_key");
    const digest = requestDigest({ execution_id, key, payload: raw.payload });
    const prior = await findReceipt(deps.db, { run_id, scope_id, ingress_id: raw.request_id, request_digest: digest });
    if (prior.kind === "replay") {
      if (prior.receipt.kind !== "committed") return c.json({ error: "decision_rejected receipt replay not yet supported" }, 500);
      return c.json(publicationReceipt(raw.request_id, prior.receipt, null), 202);
    }
    if (prior.kind === "conflict") return c.json({ error: "request ID reused with different evidence" }, 409);
    const rows = await deps.db.query<SelectedEvidence>(`SELECT b.source,s.scope_key,i.payload FROM authority.execution_selection x
      JOIN authority.scope_instance s ON s.id=x.scope_id JOIN authority.run r ON r.id=s.run_id
      JOIN authority.definition_bundle b ON b.id=r.definition_bundle_id
      JOIN authority.effect_intent i ON i.execution_id=x.execution_id AND i.payload->>'action'='start'
      WHERE x.scope_id=$1 AND x.execution_id=$2 AND s.run_id=$3`, [scope_id, execution_id, run_id]);
    const selected = rows[0];
    const fact = selected?.source.scopes.find((scope) => scope.key === selected.scope_key)?.facts.find((fact) => fact.key === key);
    if (!selected || !fact || !selected.payload.invocation.selection.definition.settings.some((setting) => setting.key === "evidence_fact" && setting.value === key))
      return c.json({ error: "selected execution cannot supply this fact" }, 422);
    const checked = await deps.core.request("validate_payload", { bundle: selected.source, schema: fact.payload_schema, payload: raw.payload });
    if (!checked.ok || checked.value.kind !== "validated") return c.json({ error: "evidence does not match its checked schema" }, 422);
    const result = await deps.mutations.decide({ run_id, scope_id, execution_authority: execution_id, request_digest: digest,
      ingress_id: raw.request_id, trigger: { id: raw.request_id, key, payload: checked.value.value }, operator_version: null });
    if (!result.ok) return c.json({ error: result.error }, 422);
    if (result.value.kind === "Conflict") return c.json(result.value, 409);
    if (result.value.kind === "Rejected") return c.json(result.value, 422);
    if (result.value.kind === "snapshot_too_large") return c.json(result.value, 413);
    if (result.value.kind === "DecisionRejected") return c.json({ error: result.value.error }, 422);
    void deps.wake(c.req.param("run_id") as RunId).catch(() => undefined);
    return c.json(publicationReceipt(raw.request_id, result.value.receipt, null), 202);
  });
}
