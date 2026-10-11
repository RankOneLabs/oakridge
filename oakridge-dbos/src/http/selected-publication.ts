import type { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import type { CoreClient } from "../core-client/client";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { EffectPayload } from "../effects/intents";
import type { MutationService } from "../storage/mutation-service";
import { requestDigest, findReceipt } from "../storage/receipts";
import type { OutputSlotRecord, RunId, ScopeId, ScopeInstanceRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { MAX_PUBLICATION_VALUE_BYTES, publicationReceipt, publicationRevisionId, publicationValueBytes } from "./publication";
import { CORE_MAX_FRAME_BYTES } from "../core-client/generated-contracts";
import { readScopeView } from "../storage/projection-reader";
import { measureAuthoritySnapshot } from "../effects/operations/selected-publication-contract";
import { readSnapshot } from "../storage/snapshot-reader";

interface SelectedOutputRequest { readonly request_id: string; readonly predecessor_id: string | null; readonly collection_key: string; readonly body: unknown }
interface PublicationDependencies { readonly db: TransactionalSqlExecutor; readonly core: CoreClient; readonly mutations: MutationService; readonly wake: (run_id: RunId) => Promise<void> }
interface SelectedExecution { readonly source: DefinitionBundle; readonly scope_key: string; readonly payload: EffectPayload }
interface ExecutionSecretRow { readonly publication_secret_hash: string | null }
export async function hasExecutionSecret(db: TransactionalSqlExecutor, run_id: RunId, scope_id: ScopeId, execution_id: string, header: string | undefined): Promise<boolean> {
  const rows = await db.query<ExecutionSecretRow>(`SELECT e.publication_secret_hash FROM authority.execution e
    JOIN authority.execution_selection x ON x.scope_id=e.scope_id AND x.execution_id=e.id AND x.generation=e.generation
    WHERE e.id=$1 AND e.scope_id=$2 AND e.run_id=$3 AND e.status='pending'`, [execution_id, scope_id, run_id]);
  const expected = rows[0]?.publication_secret_hash;
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const actual = createHash("sha256").update(header.slice(7)).digest("hex");
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
function decodeOutput(value: unknown): SelectedOutputRequest | null {
  if (!value || typeof value !== "object" || !("request_id" in value) || typeof value.request_id !== "string" || !value.request_id
    || !("predecessor_id" in value) || !(value.predecessor_id === null || typeof value.predecessor_id === "string")
    || !("collection_key" in value) || typeof value.collection_key !== "string" || !("body" in value)) return null;
  return { request_id: value.request_id, predecessor_id: value.predecessor_id, collection_key: value.collection_key, body: value.body };
}

async function readSelectedExecution(db: TransactionalSqlExecutor, scope_id: ScopeId, execution_id: string): Promise<SelectedExecution | null> {
  const rows = await db.query<SelectedExecution>(`SELECT b.source,s.scope_key,i.payload FROM authority.execution_selection x
      JOIN authority.scope_instance s ON s.id=x.scope_id JOIN authority.run r ON r.id=s.run_id
      JOIN authority.definition_bundle b ON b.id=r.definition_bundle_id
      JOIN authority.effect_intent i ON i.execution_id=x.execution_id AND i.payload->>'action'='start'
      WHERE x.scope_id=$1 AND x.execution_id=$2`, [scope_id, execution_id]);
  return rows[0] ?? null;
}

/** Raw worker bodies cross the checked core boundary before any publication is committed. */
export function installSelectedPublicationApi(app: Hono, deps: PublicationDependencies): void {
  app.get("/api/runs/:run_id/scopes/:scope_id/executions/:execution_id/contract", async (c) => {
    const run_id = c.req.param("run_id") as RunId;
    const scope_id = c.req.param("scope_id") as ScopeId;
    const execution_id = c.req.param("execution_id");
    if (!await hasExecutionSecret(deps.db, run_id, scope_id, execution_id, c.req.header("authorization"))) return c.json({ error: "execution_authority_refused" }, 403);
    const view = await readScopeView(deps.db, scope_id);
    if (!view || view.run_id !== run_id) return c.json({ error: "scope_not_found" }, 404);
    const selected = await readSelectedExecution(deps.db, scope_id, execution_id);
    const scope = selected?.source.scopes.find((scope) => scope.key === selected.scope_key);
    if (!selected || !scope) return c.json({ error: "selected execution not found" }, 404);
    const selected_keys = selected.payload.invocation.selection.definition.outputs;
    let remaining_frame_bytes = CORE_MAX_FRAME_BYTES;
    for (const output_key of selected_keys) {
      const output = scope.outputs.find((output) => output.key === output_key);
      const event = scope.facts.find((fact) => fact.key === output?.publication_trigger);
      if (!output?.publication_trigger || !event) return c.json({ error: "publication trigger is not configured" }, 422);
      const trigger = await deps.core.request("validate_payload", { bundle: selected.source, schema: event.payload_schema, payload: {} });
      if (!trigger.ok || trigger.value.kind !== "validated") return c.json({ error: "publication trigger payload is invalid" }, 422);
      const measured = await readSnapshot(deps.db, scope_id, { id: "frame-budget", key: output.publication_trigger, payload: trigger.value.value });
      if (!measured) return c.json({ error: "scope_not_found" }, 404);
      // The shared budget must fit every output this execution can publish.
      remaining_frame_bytes = Math.min(remaining_frame_bytes, Math.max(0, CORE_MAX_FRAME_BYTES - measureAuthoritySnapshot(measured).bytes));
    }
    return c.json({ scope_id, execution_id, scope_version: view.cursor.scope_version,
      outputs: view.outputs.filter((slot) => selected_keys.includes(slot.output_key)).map((slot) => ({ output_key: slot.output_key, collection_key: slot.collection_key,
        predecessor_id: slot.current_revision?.id ?? null, slot_version: slot.version })),
      remaining_frame_bytes });
  });
  app.put("/api/runs/:run_id/scopes/:scope_id/executions/:execution_id/outputs/:output_key", async (c) => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const body = decodeOutput(raw);
    if (!body) return c.json({ error: "request_id, predecessor_id, collection_key and body are required" }, 400);
    const run_id = c.req.param("run_id") as RunId;
    const scope_id = c.req.param("scope_id") as ScopeId;
    const execution_id = c.req.param("execution_id");
    if (!await hasExecutionSecret(deps.db, run_id, scope_id, execution_id, c.req.header("authorization"))) return c.json({ error: "execution_authority_refused" }, 403);
    const output_key = c.req.param("output_key");
    const revision_id = publicationRevisionId(run_id, scope_id, body.request_id);
    const digest = requestDigest({ execution_id, output_key, body });
    const prior = await findReceipt(deps.db, { run_id, scope_id, ingress_id: body.request_id, request_digest: digest });
    if (prior.kind === "replay") return c.json(publicationReceipt(body.request_id, prior.receipt, revision_id), 200);
    if (prior.kind === "conflict") return c.json({ error: "request ID reused with different publication content" }, 409);
    const owners = await deps.db.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE id=$1 AND run_id=$2", [scope_id, run_id]);
    if (!owners.length) return c.json({ error: "scope not found in run" }, 404);
    const selected = await readSelectedExecution(deps.db, scope_id, execution_id);
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
    // The raw guard above bounds transport; the staged value is the checked expansion, which the operator path measures too.
    const checked_bytes = publicationValueBytes(checked.value.value);
    if (checked_bytes > MAX_PUBLICATION_VALUE_BYTES) return c.json({ kind: "oversized_payload", bytes: checked_bytes, limit: MAX_PUBLICATION_VALUE_BYTES }, 413);
    const trigger = await deps.core.request("validate_payload", { bundle: selected.source, schema: event.payload_schema, payload: {} });
    if (!trigger.ok || trigger.value.kind !== "validated") return c.json({ error: "publication trigger payload is invalid" }, 422);
    const slots = await deps.db.query<OutputSlotRecord>("SELECT * FROM authority.output_slot WHERE scope_id=$1 AND output_key=$2 AND collection_key=$3", [scope_id, output_key, body.collection_key]);
    const slot = slots[0];
    if ((slot?.current_revision_id ?? null) !== body.predecessor_id) return c.json({ error: "output predecessor changed" }, 409);
    const result = await deps.mutations.decide({ run_id, scope_id, execution_authority: execution_id, request_digest: digest,
      ingress_id: body.request_id, operator_version: null, trigger: { id: body.request_id, key, payload: trigger.value.value },
      outputs: [{ scope_id, output_key, collection_key: body.collection_key, body: checked.value.value,
        revision_id, predecessor_id: body.predecessor_id, expected_slot_version: slot ? Number(slot.version) : null, execution_id }] });
    if (!result.ok) return c.json({ error: result.error }, result.error.operation === "validate_publication_protocol" ? 500 : 422);
    if (result.value.kind === "Conflict") return c.json(result.value, 409);
    if (result.value.kind === "Rejected") return c.json(result.value, 422);
    if (result.value.kind === "snapshot_too_large") return c.json(result.value, 413);
    void deps.wake(c.req.param("run_id") as RunId).catch(() => undefined);
    return c.json(publicationReceipt(body.request_id, result.value.receipt, revision_id), result.value.kind === "Committed" ? 201 : 200);
  });
}
