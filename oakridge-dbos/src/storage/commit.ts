import type { CheckedProgram, CheckedValue, DecisionOutcome, DefinitionBundle } from "../core-client/generated-contracts";
import type { CapacityChange } from "./capacity";
import { applyCapacityChanges } from "./capacity";
import { findReceipt, type IngressIdentity } from "./receipts";
import type { AuthoritySnapshot, ReadSet } from "./snapshot-reader";
import { hasSameReadSet } from "./snapshot-reader";
import type { CommitReceipt, ScopeId } from "./schema-records";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import { selectedInvocation, type InvocationId } from "../effects/provider";
import type { EffectPayload } from "../effects/leases";
import { validateDecision, validateStorageAuthority } from "./storage-validator";

export interface DomainError { readonly operation: string; readonly entity_id: string; readonly detail: string }
export type Result<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: DomainError };
export interface OutputPublication { readonly scope_id: ScopeId; readonly output_key: string; readonly collection_key: string; readonly body: CheckedValue; readonly predecessor_id: string | null; readonly expected_slot_version: number | null; readonly execution_id: string | null }
export interface EffectPublication { readonly effect_key: string; readonly payload: CheckedValue; readonly execution_id: string | null }
export interface CommitRequest { readonly identity: IngressIdentity; readonly read_set: ReadSet; readonly decision: DecisionOutcome; readonly outputs: readonly OutputPublication[]; readonly capacity: readonly CapacityChange[]; readonly effects: readonly EffectPublication[]; readonly operator_version: number | null }
export type CommitResult = { readonly kind: "Committed"; readonly receipt: CommitReceipt } | { readonly kind: "Replayed"; readonly receipt: CommitReceipt } | { readonly kind: "Conflict"; readonly detail: string } | { readonly kind: "Rejected"; readonly detail: string };

class AbortCommit extends Error { constructor(readonly outcome: CommitResult) { super("detail" in outcome ? outcome.detail : outcome.kind); } }
function fail(outcome: CommitResult): never { throw new AbortCommit(outcome); }

async function lockOwners(tx: SqlExecutor, request: CommitRequest): Promise<void> {
  // A run advisory lock serializes membership changes and protects missing rows.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [request.identity.run_id]);
  const owners = new Set<string>([request.identity.scope_id, ...request.capacity.map((c) => c.pool_id), ...request.outputs.map((o) => o.scope_id), ...request.read_set.rows.map((r) => r.id)]);
  for (const id of [...owners].sort()) {
    const witnesses = request.read_set.rows.filter((r) => r.id === id).sort((a, b) => a.relation.localeCompare(b.relation));
    for (const witness of witnesses) await tx.query(`SELECT id FROM authority.${witness.relation} WHERE id=$1 FOR UPDATE`, [id]);
  }
}

async function writeOutputs(tx: SqlExecutor, request: CommitRequest): Promise<void> {
  for (const output of request.outputs) {
    const slots = await tx.query<{ id: string; current_revision_id: string | null; version: string | number }>("SELECT id,current_revision_id,version FROM authority.output_slot WHERE scope_id=$1 AND output_key=$2 AND collection_key=$3 FOR UPDATE", [output.scope_id, output.output_key, output.collection_key]);
    const slot = slots[0];
    if ((slot?.current_revision_id ?? null) !== output.predecessor_id || (slot ? Number(slot.version) : null) !== output.expected_slot_version) fail({ kind: "Conflict", detail: "output predecessor or version changed" });
    const revision_id = crypto.randomUUID();
    await tx.query("INSERT INTO authority.artifact_revision (id,scope_id,execution_id,output_key,collection_key,body,predecessor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [revision_id, output.scope_id, output.execution_id, output.output_key, output.collection_key || null, JSON.stringify(output.body), output.predecessor_id]);
    if (slot) await tx.query("UPDATE authority.output_slot SET current_revision_id=$1,version=version+1 WHERE id=$2", [revision_id, slot.id]);
    else await tx.query("INSERT INTO authority.output_slot (id,scope_id,output_key,collection_key,current_revision_id) VALUES ($1,$2,$3,$4,$5)", [crypto.randomUUID(), output.scope_id, output.output_key, output.collection_key, revision_id]);
  }
}

async function revokeSelectedEffects(tx: SqlExecutor, scope_id: string, worker: string): Promise<void> {
  const starts = await tx.query<{ id: string; execution_id: string; effect_key: string; payload: EffectPayload; status: string }>(`SELECT i.* FROM authority.effect_intent i
    JOIN authority.execution e ON e.id=i.execution_id WHERE i.scope_id=$1 AND e.worker_key=$2 AND i.payload->>'action'='start' FOR UPDATE OF i`, [scope_id, worker]);
  for (const start of starts) {
    if (["pending", "in_flight", "uncertain"].includes(start.status)) await tx.query("UPDATE authority.effect_intent SET status='revoked',version=version+1 WHERE id=$1", [start.id]);
    await tx.query(`INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload,status)
      VALUES ($1,$2,$3,$4,$5,'cleanup_pending') ON CONFLICT (scope_id,effect_key) DO NOTHING`,
      [crypto.randomUUID(), scope_id, start.execution_id, `${start.effect_key}:stop`, JSON.stringify({ invocation: start.payload.invocation, action: "stop", handle: start.payload.handle })]);
  }
}

async function writeDecision(tx: SqlExecutor, request: CommitRequest, source: AuthoritySnapshot): Promise<CommitReceipt> {
  const scope_id = source.owner.id;
  const execution_ids: string[] = [];
  const definitions = await tx.query<{ source: DefinitionBundle; checked_program: CheckedProgram }>("SELECT b.source,b.checked_program FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [source.owner.run_id]);
  const definition = definitions[0];
  if (!definition) fail({ kind: "Rejected", detail: "definition bundle missing" });
  if (request.decision.kind === "apply") {
    for (const mutation of request.decision.mutations) {
      if (mutation.kind === "set_state") await tx.query("UPDATE authority.scope_instance SET local_state=$1,version=version+1 WHERE id=$2", [JSON.stringify(mutation.value), scope_id]);
      if (mutation.kind === "export") await tx.query("INSERT INTO authority.scope_export (id,scope_id,export_key,value) VALUES ($1,$2,$3,$4) ON CONFLICT (scope_id,export_key) DO UPDATE SET value=excluded.value,version=authority.scope_export.version+1", [crypto.randomUUID(), scope_id, mutation.key, JSON.stringify(mutation.value)]);
      if (mutation.kind === "revoke" || mutation.kind === "stop") {
        await revokeSelectedEffects(tx, scope_id, mutation.worker);
        await tx.query("UPDATE authority.execution_selection SET generation=generation+1,execution_id=NULL,version=version+1 WHERE scope_id=$1 AND worker_key=$2", [scope_id, mutation.worker]);
      }
      if (mutation.kind === "activate_child") {
        const declared = definition.source.scopes.find((item) => item.key === source.owner.scope_key)?.children.find((item) => item.key === mutation.key);
        const child_state = definition.checked_program.scopes.find((item) => item.key === declared?.scope)?.initial;
        if (!declared || !child_state) fail({ kind: "Rejected", detail: "child definition missing" });
        const child_id = crypto.randomUUID();
        await tx.query("INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,input,local_state) VALUES ($1,$2,$3,$4,$5,$6,$7)", [child_id, source.owner.run_id, scope_id, declared.scope, mutation.key, JSON.stringify(mutation.input), JSON.stringify(child_state)]);
      }
      if (mutation.kind === "activate_collection") {
        const members: string[] = [];
        for (const child of mutation.materialization.children) {
          const child_state = definition.checked_program.scopes.find((item) => item.key === child.scope)?.initial;
          if (!child_state) fail({ kind: "Rejected", detail: "collection child definition missing" });
          const child_id = crypto.randomUUID();
          members.push(child_id);
          await tx.query("INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,input,local_state) VALUES ($1,$2,$3,$4,$5,$6,$7)", [child_id, source.owner.run_id, scope_id, child.scope, child.key, JSON.stringify(child.input), JSON.stringify(child_state)]);
        }
        await tx.query("INSERT INTO authority.child_collection (id,scope_id,collection_key,members) VALUES ($1,$2,$3,$4) ON CONFLICT (scope_id,collection_key) DO UPDATE SET members=excluded.members,version=authority.child_collection.version+1", [crypto.randomUUID(), scope_id, mutation.key, JSON.stringify(members)]);
      }
    }
    for (const invocation of request.decision.invocations) {
      const execution_id = crypto.randomUUID();
      execution_ids.push(execution_id);
      const selection = await tx.query<{ generation: string | number }>("SELECT generation FROM authority.execution_selection WHERE scope_id=$1 AND worker_key=$2 FOR UPDATE", [scope_id, invocation.selection.worker]);
      const generation = Number(selection[0]?.generation ?? 0) + 1;
      await tx.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ($1,$2,$3,$4,'pending')", [execution_id, scope_id, invocation.selection.worker, generation]);
      await tx.query("INSERT INTO authority.execution_selection (id,scope_id,worker_key,execution_id,generation) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (scope_id,worker_key) DO UPDATE SET execution_id=excluded.execution_id,generation=excluded.generation,version=authority.execution_selection.version+1", [crypto.randomUUID(), scope_id, invocation.selection.worker, execution_id, generation]);
    }
    if (request.decision.outcome) await tx.query("UPDATE authority.scope_instance SET outcome=$1,is_terminal=true,version=version+1 WHERE id=$2", [JSON.stringify(request.decision.outcome), scope_id]);
  }
  await writeOutputs(tx, request);
  const capacity = await applyCapacityChanges(tx, request.capacity);
  if (!capacity.ok) fail({ kind: "Rejected", detail: `${capacity.error.operation}/${capacity.error.entity_id}: ${capacity.error.detail}` });
  for (const [index, effect] of request.effects.entries()) {
    const id = crypto.randomUUID();
    const execution_id = effect.execution_id ?? execution_ids[index] ?? null;
    const selection = request.decision.kind === "apply" ? request.decision.invocations[index] : null;
    const payload: EffectPayload | CheckedValue = selection && execution_id
      ? { invocation: selectedInvocation(id as InvocationId, execution_id, selection), action: "start", handle: null } : effect.payload;
    await tx.query("INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload) VALUES ($1,$2,$3,$4,$5)", [id, scope_id, execution_id, effect.effect_key, JSON.stringify(payload)]);
  }
  await tx.query("INSERT INTO authority.fact (id,scope_id,fact_key,payload) VALUES ($1,$2,$3,$4)", [crypto.randomUUID(), scope_id, source.snapshot.trigger.key, JSON.stringify(source.snapshot.trigger.payload)]);
  const transition_id = crypto.randomUUID();
  await tx.query("INSERT INTO authority.transition (id,scope_id,trigger_id,decision) VALUES ($1,$2,$3,$4)", [transition_id, scope_id, source.snapshot.trigger.id, JSON.stringify(request.decision)]);
  await tx.query("UPDATE authority.scope_instance SET version=version+1 WHERE id=$1", [scope_id]);
  const owners = await tx.query<{ version: string | number }>("SELECT version FROM authority.scope_instance WHERE id=$1", [scope_id]);
  const receipt = { transition_id, scope_version: Number(owners[0]!.version) };
  await tx.query("INSERT INTO authority.ingress_receipt (id,run_id,scope_id,ingress_id,request_digest,result) VALUES ($1,$2,$3,$4,$5,$6)", [crypto.randomUUID(), request.identity.run_id, scope_id, request.identity.ingress_id, request.identity.request_digest, JSON.stringify(receipt)]);
  return receipt;
}

export async function commitDecision(db: TransactionalSqlExecutor, request: CommitRequest, source: AuthoritySnapshot): Promise<Result<CommitResult>> {
  const checked = validateDecision(request, source);
  if (!checked.ok) return checked;
  try {
    const result = await db.transaction(async (tx): Promise<CommitResult> => {
      await lockOwners(tx, request);
      const receipt = await findReceipt(tx, request.identity);
      if (receipt.kind === "replay") return { kind: "Replayed", receipt: receipt.receipt };
      if (receipt.kind === "conflict") return { kind: "Conflict", detail: "ingress identity reused with different request content" };
      if (!await hasSameReadSet(tx, request.read_set)) return { kind: "Conflict", detail: "read set changed; refresh decision" };
      const storage_check = await validateStorageAuthority(tx, request, source);
      if (!storage_check.ok) return { kind: "Rejected", detail: storage_check.error.detail };
      if (request.operator_version !== null && request.operator_version !== Number(source.owner.version)) return { kind: "Conflict", detail: "operator target version changed; refresh decision" };
      if (source.owner.is_terminal) return { kind: "Rejected", detail: "owner is terminal" };
      return { kind: "Committed", receipt: await writeDecision(tx, request, source) };
    });
    return { ok: true, value: result };
  } catch (error) {
    if (error instanceof AbortCommit) return { ok: true, value: error.outcome };
    return { ok: false, error: { operation: "commit_decision", entity_id: request.identity.scope_id, detail: String(error) } };
  }
}
