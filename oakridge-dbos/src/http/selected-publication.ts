import type { Hono } from "hono";
import type { CoreClient } from "../core-client/client";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { EffectPayload } from "../effects/intents";
import type { MutationService } from "../storage/mutation-service";
import { requestDigest, findReceipt } from "../storage/receipts";
import type { OutputSlotRecord, RunId, ScopeId, ScopeInstanceRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { MAX_PUBLICATION_VALUE_BYTES, publicationValueBytes } from "./publication";

interface SelectedOutputRequest { readonly request_id: string; readonly predecessor_id: string | null; readonly collection_key: string; readonly body: unknown }
interface PublicationDependencies { readonly db: TransactionalSqlExecutor; readonly core: CoreClient; readonly mutations: MutationService; readonly wake: (run_id: RunId) => Promise<void> }
interface SelectedExecution { readonly source: DefinitionBundle; readonly scope_key: string; readonly payload: EffectPayload }
function decodeOutput(value: unknown): SelectedOutputRequest | null {
  if (!value || typeof value !== "object" || !("request_id" in value) || typeof value.request_id !== "string" || !value.request_id
    || !("predecessor_id" in value) || !(value.predecessor_id === null || typeof value.predecessor_id === "string")
    || !("collection_key" in value) || typeof value.collection_key !== "string" || !("body" in value)) return null;
  return { request_id: value.request_id, predecessor_id: value.predecessor_id, collection_key: value.collection_key, body: value.body };
}

/** Raw worker bodies cross the checked core boundary before any publication is committed. */
export function installSelectedPublicationApi(app: Hono, deps: PublicationDependencies): void {
  app.put("/api/runs/:run_id/scopes/:scope_id/executions/:execution_id/outputs/:output_key", async (c) => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const body = decodeOutput(raw);
    if (!body) return c.json({ error: "request_id, predecessor_id, collection_key and body are required" }, 400);
    const run_id = c.req.param("run_id") as RunId;
    const scope_id = c.req.param("scope_id") as ScopeId;
    const execution_id = c.req.param("execution_id");
    const output_key = c.req.param("output_key");
    const digest = requestDigest({ execution_id, output_key, body });
    const prior = await findReceipt(deps.db, { run_id, scope_id, ingress_id: body.request_id, request_digest: digest });
    if (prior.kind === "replay") return c.json({ kind: "Replayed", receipt: prior.receipt });
    if (prior.kind === "conflict") return c.json({ error: "request ID reused with different publication content" }, 409);
    const owners = await deps.db.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE id=$1 AND run_id=$2", [scope_id, run_id]);
    if (!owners.length) return c.json({ error: "scope not found in run" }, 404);
    const rows = await deps.db.query<SelectedExecution>(`SELECT b.source,s.scope_key,i.payload FROM authority.execution_selection x
      JOIN authority.scope_instance s ON s.id=x.scope_id JOIN authority.run r ON r.id=s.run_id
      JOIN authority.definition_bundle b ON b.id=r.definition_bundle_id
      JOIN authority.effect_intent i ON i.execution_id=x.execution_id AND i.payload->>'action'='start'
      WHERE x.scope_id=$1 AND x.execution_id=$2`, [scope_id, execution_id]);
    const selected = rows[0];
    const scope = selected?.source.scopes.find((scope) => scope.key === selected.scope_key);
    const output = scope?.outputs.find((output) => output.key === output_key);
    if (!selected || !output || !selected.payload.invocation.selection.definition.outputs.includes(output_key))
      return c.json({ error: "selected execution cannot publish this output" }, 422);
    const key = output.publication_trigger;
    const event = scope?.facts.find((fact) => fact.key === key);
    if (!key || !event) return c.json({ error: "publication trigger is not configured" }, 422);
    const value_bytes = publicationValueBytes(body.body);
    if (value_bytes > MAX_PUBLICATION_VALUE_BYTES) return c.json({ kind: "oversized_payload", bytes: value_bytes, limit: MAX_PUBLICATION_VALUE_BYTES }, 413);
    const checked = await deps.core.request("validate_payload", { bundle: selected.source, schema: output.schema, payload: body.body });
    if (!checked.ok || checked.value.kind !== "validated") return c.json({ error: "output body does not match its checked schema", detail: checked.ok ? "unexpected core response" : checked.error }, 422);
    const trigger = await deps.core.request("validate_payload", { bundle: selected.source, schema: event.payload_schema, payload: {} });
    if (!trigger.ok || trigger.value.kind !== "validated") return c.json({ error: "publication trigger payload is invalid" }, 422);
    const slots = await deps.db.query<OutputSlotRecord>("SELECT * FROM authority.output_slot WHERE scope_id=$1 AND output_key=$2 AND collection_key=$3", [scope_id, output_key, body.collection_key]);
    const slot = slots[0];
    if ((slot?.current_revision_id ?? null) !== body.predecessor_id) return c.json({ error: "output predecessor changed" }, 409);
    const hash = requestDigest({ run_id, scope_id, request_id: body.request_id });
    const revision_id = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
    const result = await deps.mutations.decide({ run_id, scope_id, execution_authority: execution_id, request_digest: digest,
      ingress_id: body.request_id, operator_version: null, trigger: { id: body.request_id, key, payload: trigger.value.value },
      outputs: [{ scope_id, output_key, collection_key: body.collection_key, body: checked.value.value,
        revision_id, predecessor_id: body.predecessor_id, expected_slot_version: slot ? Number(slot.version) : null, execution_id }] });
    if (!result.ok) return c.json({ error: result.error }, 422);
    if (result.value.kind === "Conflict") return c.json(result.value, 409);
    if (result.value.kind === "Rejected") return c.json(result.value, 422);
    if (result.value.kind === "snapshot_too_large") return c.json(result.value, 413);
    void deps.wake(c.req.param("run_id") as RunId).catch(() => undefined);
    return c.json({ ...result.value, revision_id }, result.value.kind === "Committed" ? 201 : 200);
  });
}
