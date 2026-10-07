import { type CompiledBundle, type CheckedValue, type DecisionOutcome, type DefinitionBundle } from "../core-client/generated-contracts";
import { createHash, randomBytes } from "node:crypto";
import type { CapacityChange } from "./capacity";
import { applyCapacityChanges } from "./capacity";
import { findReceipt, type IngressIdentity } from "./receipts";
import type { AuthoritySnapshot, ReadSet } from "./snapshot-reader";
import { hasSameReadSet, readSnapshot, READ_RELATIONS, CAPACITY_READ_RELATIONS } from "./snapshot-reader";
import type { ChildCollectionMember, CommitReceipt, ScopeId } from "./schema-records";
import { inTransaction, type SqlExecutor, type TransactionalSqlExecutor } from "./sql-executor";
import { pinProviderRequest } from "../effects/operations/selected-request";
import { MAX_SNAPSHOT_BYTES, measureAuthoritySnapshot } from "../effects/operations/selected-publication-contract";
export { MAX_SNAPSHOT_BYTES, measureAuthoritySnapshot } from "../effects/operations/selected-publication-contract";
import { selectedInvocation, type InvocationId } from "../effects/provider";
import type { EffectPayload } from "../effects/intents";
import { revokeStarts } from "./revocation";
import { validateDecision, validateStorageAuthority } from "./storage-validator";

export interface DomainError { readonly operation: string; readonly entity_id: string; readonly detail: string; readonly reason?: CommitRejectionReason }
export type Result<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: DomainError };
export interface OutputPublication { readonly revision_id?: string; readonly scope_id: ScopeId; readonly output_key: string; readonly collection_key: string; readonly body: CheckedValue; readonly predecessor_id: string | null; readonly expected_slot_version: number | null; readonly execution_id: string | null }
export interface EffectPublication { readonly effect_key: string; readonly payload: CheckedValue; readonly execution_id: string | null }
export interface CommitRequest { readonly execution_authority?: string; readonly child_cancellations?: readonly import("./child-cancellation").ChildCancellation[]; readonly identity: IngressIdentity; readonly read_set: ReadSet; readonly decision: DecisionOutcome; readonly outputs: readonly OutputPublication[]; readonly capacity: readonly CapacityChange[]; readonly effects: readonly EffectPublication[]; readonly operator_version: number | null }
export type CommitRejectionReason = "owner_terminal" | "generation_revoked" | "capacity_unavailable" | "database_constraint" | "invalid";
export type CommitResult = { readonly kind: "Committed"; readonly receipt: CommitReceipt } | { readonly kind: "Replayed"; readonly receipt: CommitReceipt } | { readonly kind: "Conflict"; readonly detail: string } | { readonly kind: "Rejected"; readonly reason: CommitRejectionReason; readonly detail: string; readonly constraint?: string } | { readonly kind: "snapshot_too_large"; readonly scope: ScopeId; readonly bytes: number; readonly limit: number; readonly largest_roots: readonly { readonly root: string; readonly bytes: number }[] };

class AbortCommit extends Error { constructor(readonly outcome: CommitResult) { super("detail" in outcome ? outcome.detail : outcome.kind); } }
function fail(outcome: CommitResult): never { throw new AbortCommit(outcome); }

function databaseFailure(error: unknown): CommitResult | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  if (error.code === "40P01" || error.code === "40001") return { kind: "Conflict", detail: `database concurrency conflict (${error.code}); refresh decision` };
  if (error.code === "23505") {
    const constraint = "constraint" in error && typeof error.constraint === "string" ? error.constraint : "unknown constraint";
    return { kind: "Rejected", reason: "database_constraint", detail: `unique constraint violated: ${constraint}`, constraint };
  }
  return null;
}

async function measureWrittenSnapshots(tx: SqlExecutor, source: AuthoritySnapshot, child_cancellations: CommitRequest["child_cancellations"], definition: { source: DefinitionBundle; checked_program: CompiledBundle }): Promise<void> {
  const scope_ids = new Set<ScopeId>([source.owner.id as ScopeId, ...(child_cancellations ?? []).map((child) => child.source.owner.id as ScopeId)]);
  if (source.owner.parent_id) scope_ids.add(source.owner.parent_id as ScopeId);
  for (const child of child_cancellations ?? []) if (child.source.owner.parent_id) scope_ids.add(child.source.owner.parent_id as ScopeId);
  for (const scope_id of scope_ids) {
    // A parent has no trigger at a child export/outcome boundary. The current
    // checked trigger is a synthetic measurement trigger for that parent.
    const measured = await readSnapshot(inTransaction(tx), scope_id, source.snapshot.trigger, source.snapshot.random_seed, definition);
    if (!measured) continue;
    const measurement = measureAuthoritySnapshot(measured);
    if (scope_id === source.owner.id && JSON.stringify(measurement.roots) !== JSON.stringify(source.reads))
      fail({ kind: "Rejected", reason: "invalid", detail: "measured observation roots differ from the decision roots" });
    if (measurement.bytes <= MAX_SNAPSHOT_BYTES) continue;
    fail({ kind: "snapshot_too_large", scope: scope_id, bytes: measurement.bytes, limit: MAX_SNAPSHOT_BYTES, largest_roots: measurement.largest_roots });
  }
}

async function lockOwners(tx: SqlExecutor, request: CommitRequest): Promise<void> {
  for (const witness of request.read_set.rows) {
    if (!(READ_RELATIONS as readonly string[]).includes(witness.relation)) fail({ kind: "Rejected", reason: "invalid", detail: `unknown read relation: ${witness.relation}` });
  }
  // Global lock order: run advisory lock first, then relation.localeCompare order,
  // then IDs within each relation. Capacity changes take the exclusive run lock;
  // unrelated sibling decisions share it and only lock their own subtree rows.
  await tx.query(request.capacity.length
    ? "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))"
    : "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [request.identity.run_id]);
  const by_relation = new Map<string, string[]>();
  for (const witness of request.read_set.rows) {
    if (!request.capacity.length && CAPACITY_READ_RELATIONS.includes(witness.relation)) continue;
    by_relation.set(witness.relation, [...(by_relation.get(witness.relation) ?? []), witness.id]);
  }
  for (const relation of [...by_relation.keys()].sort((a, b) => a.localeCompare(b))) {
    const ids = [...new Set(by_relation.get(relation)!)].sort();
    await tx.query(`SELECT id FROM authority.${relation} WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, [ids]);
  }
}

async function writeOutputs(tx: SqlExecutor, request: CommitRequest): Promise<void> {
  for (const output of request.outputs) {
    const slots = await tx.query<{ id: string; current_revision_id: string | null; version: string | number }>("SELECT id,current_revision_id,version FROM authority.output_slot WHERE scope_id=$1 AND output_key=$2 AND collection_key=$3 FOR UPDATE", [output.scope_id, output.output_key, output.collection_key]);
    const slot = slots[0];
    if ((slot?.current_revision_id ?? null) !== output.predecessor_id || (slot ? Number(slot.version) : null) !== output.expected_slot_version) fail({ kind: "Conflict", detail: "output predecessor or version changed" });
    const revision_id = output.revision_id ?? crypto.randomUUID();
    await tx.query("INSERT INTO authority.artifact_revision (id,scope_id,execution_id,output_key,collection_key,body,predecessor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [revision_id, output.scope_id, output.execution_id, output.output_key, output.collection_key, JSON.stringify(output.body), output.predecessor_id]);
    if (slot) await tx.query("UPDATE authority.output_slot SET current_revision_id=$1,version=version+1 WHERE id=$2", [revision_id, slot.id]);
    else await tx.query("INSERT INTO authority.output_slot (id,scope_id,output_key,collection_key,current_revision_id) VALUES ($1,$2,$3,$4,$5)", [crypto.randomUUID(), output.scope_id, output.output_key, output.collection_key, revision_id]);
  }
}

/** Withdraws the worker's current starts and records the stops they owe, in this transaction. */
async function revokeSelectedEffects(tx: SqlExecutor, scope_id: string, worker: string): Promise<void> {
  await revokeStarts(tx, [scope_id], worker);
}

async function writeDecision(tx: SqlExecutor, request: CommitRequest, source: AuthoritySnapshot, definition: { source: DefinitionBundle; checked_program: CompiledBundle }): Promise<CommitReceipt> {
  const scope_id = source.owner.id;
  const execution_ids: string[] = [];
  if (request.decision.kind === "apply") {
    for (const mutation of request.decision.mutations) {
      if (mutation.kind === "bind_resource") await tx.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ($1,$2,$3,$4) ON CONFLICT (scope_id,resource_key) DO UPDATE SET observation=excluded.observation,version=authority.resource_binding.version+1", [crypto.randomUUID(), scope_id, mutation.key, JSON.stringify(mutation.value)]);
      if (mutation.kind === "clear_resource") await tx.query("UPDATE authority.resource_binding SET observation=NULL,version=version+1 WHERE scope_id=$1 AND resource_key=$2", [scope_id, mutation.key]);
      if (mutation.kind === "clear_output") await tx.query("UPDATE authority.output_slot SET current_revision_id=NULL,version=version+1 WHERE scope_id=$1 AND output_key=$2", [scope_id, mutation.key]);
      if (mutation.kind === "set_state") await tx.query("UPDATE authority.scope_instance SET local_state=$1,version=version+1 WHERE id=$2", [JSON.stringify(mutation.value), scope_id]);
      if (mutation.kind === "export") await tx.query("INSERT INTO authority.scope_export (id,scope_id,export_key,value) VALUES ($1,$2,$3,$4) ON CONFLICT (scope_id,export_key) DO UPDATE SET value=excluded.value,version=authority.scope_export.version+1", [crypto.randomUUID(), scope_id, mutation.key, JSON.stringify(mutation.value)]);
      if (mutation.kind === "revoke" || mutation.kind === "stop") {
        await revokeSelectedEffects(tx, scope_id, mutation.worker);
        await tx.query("UPDATE authority.execution_selection SET generation=generation+1,execution_id=NULL,version=version+1 WHERE scope_id=$1 AND worker_key=$2", [scope_id, mutation.worker]);
      }
      if (mutation.kind === "activate_child") {
        const declared = definition.source.scopes.find((item) => item.key === source.owner.scope_key)?.children.find((item) => item.key === mutation.key);
        const child_state = definition.checked_program.scopes.find((item) => item.key === declared?.scope)?.initial;
        if (!declared || !child_state) fail({ kind: "Rejected", reason: "invalid", detail: "child definition missing" });
        const child_id = crypto.randomUUID();
        await tx.query("INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,input,local_state) VALUES ($1,$2,$3,$4,$5,$6,$7)", [child_id, source.owner.run_id, scope_id, declared.scope, mutation.key, JSON.stringify(mutation.input), JSON.stringify(child_state)]);
      }
      if (mutation.kind === "activate_collection") {
        const members: ChildCollectionMember[] = [];
        for (const child of mutation.materialization.children) {
          const child_state = definition.checked_program.scopes.find((item) => item.key === child.scope)?.initial;
          if (!child_state) fail({ kind: "Rejected", reason: "invalid", detail: "collection child definition missing" });
          const child_id = crypto.randomUUID();
          members.push({ id: child_id as ScopeId, key: child.key, depends_on: child.depends_on });
          await tx.query("INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,input,local_state,collection_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [child_id, source.owner.run_id, scope_id, child.scope, child.key, JSON.stringify(child.input), JSON.stringify(child_state), mutation.key]);
        }
        await tx.query("INSERT INTO authority.child_collection (id,scope_id,collection_key,members) VALUES ($1,$2,$3,$4) ON CONFLICT (scope_id,collection_key) DO UPDATE SET members=excluded.members,version=authority.child_collection.version+1", [crypto.randomUUID(), scope_id, mutation.key, JSON.stringify(members)]);
      }
    }
    for (const invocation of request.decision.invocations) {
      const execution_id = crypto.randomUUID();
      execution_ids.push(execution_id);
      const selection = await tx.query<{ generation: string | number }>("SELECT generation FROM authority.execution_selection WHERE scope_id=$1 AND worker_key=$2 FOR UPDATE", [scope_id, invocation.selection.worker]);
      if (selection.length) await revokeSelectedEffects(tx, scope_id, invocation.selection.worker);
      const generation = Number(selection[0]?.generation ?? 0) + 1;
      await tx.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ($1,$2,$3,$4,'pending')", [execution_id, scope_id, invocation.selection.worker, generation]);
      await tx.query("INSERT INTO authority.execution_selection (id,scope_id,worker_key,execution_id,generation) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (scope_id,worker_key) DO UPDATE SET execution_id=excluded.execution_id,generation=excluded.generation,version=authority.execution_selection.version+1", [crypto.randomUUID(), scope_id, invocation.selection.worker, execution_id, generation]);
    }
    if (request.decision.outcome) await tx.query("UPDATE authority.scope_instance SET outcome=$1,is_terminal=true,version=version+1 WHERE id=$2", [JSON.stringify(request.decision.outcome), scope_id]);
  }
  await writeOutputs(tx, request);
  const capacity = await applyCapacityChanges(tx, request.capacity);
  if (!capacity.ok) fail({ kind: "Rejected", reason: "capacity_unavailable", detail: `${capacity.error.operation}/${capacity.error.entity_id}: ${capacity.error.detail}` });
  // Every effect intent is one selected invocation, pinned here so recovery never re-renders a request.
  const invocations = request.decision.kind === "apply" ? request.decision.invocations : [];
  if (request.effects.length !== invocations.length) fail({ kind: "Rejected", reason: "invalid", detail: "effects do not pair with selected invocations" });
  for (const [index, effect] of request.effects.entries()) {
    const id = crypto.randomUUID();
    const execution_id = effect.execution_id ?? execution_ids[index] ?? null;
    const selection = invocations[index];
    if (!selection || !execution_id) fail({ kind: "Rejected", reason: "invalid", detail: "effect without a selected execution" });
    const publication_secret = randomBytes(32).toString("base64url");
    const pinned = pinProviderRequest({ invocation: selectedInvocation(id as InvocationId, execution_id, selection), bundle: definition.source, scope: source.owner, publication_secret });
    if (!pinned.ok) fail({ kind: "Rejected", reason: "invalid", detail: pinned.error.detail });
    await tx.query("UPDATE authority.execution SET publication_secret_hash=$1 WHERE id=$2", [createHash("sha256").update(publication_secret).digest("hex"), execution_id]);
    const payload: EffectPayload = { invocation: pinned.value, action: "start", handle: null };
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
  if (request.read_set.scope_id !== source.owner.id) return { ok: true, value: { kind: "Rejected", reason: "invalid", detail: "read set owner differs from decision owner" } };
  try {
    const result = await db.transaction(async (tx): Promise<CommitResult> => {
      await lockOwners(tx, request);
      const receipt = await findReceipt(tx, request.identity);
      if (receipt.kind === "replay") return { kind: "Replayed", receipt: receipt.receipt };
      if (receipt.kind === "conflict") return { kind: "Conflict", detail: "ingress identity reused with different request content" };
      if (!await hasSameReadSet(tx, request.read_set)) return { kind: "Conflict", detail: "read set changed; refresh decision" };
      const definitions = await tx.query<{ source: DefinitionBundle; checked_program: CompiledBundle }>("SELECT b.source,b.checked_program FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [source.owner.run_id]);
      const definition = definitions[0];
      if (!definition) fail({ kind: "Rejected", reason: "invalid", detail: "definition bundle missing" });
      const storage_check = await validateStorageAuthority(tx, request, source, definition.source);
      if (!storage_check.ok) return { kind: "Rejected", reason: storage_check.error.reason === "generation_revoked" ? "generation_revoked" : "invalid", detail: storage_check.error.detail };
      if (request.operator_version !== null && request.operator_version !== Number(source.owner.version)) return { kind: "Conflict", detail: "operator target version changed; refresh decision" };
      if (source.owner.is_terminal) return { kind: "Rejected", reason: "owner_terminal", detail: "owner is terminal" };
      const cancellation_keys = request.decision.kind === "apply" ? request.decision.mutations.flatMap((mutation) => mutation.kind === "cancel_children" ? [mutation.key] : []) : [];
      if (cancellation_keys.length || request.child_cancellations?.length) {
        const expected = await tx.query<{ id: string }>(`WITH RECURSIVE descendants AS (
          SELECT s.* FROM authority.scope_instance s WHERE s.parent_id=$1 AND
          ((s.collection_key IS NULL AND s.child_key=ANY($2::text[])) OR s.id IN (SELECT COALESCE(member->>'id', member#>>'{}')
            FROM authority.child_collection c, jsonb_array_elements(c.members) member
            WHERE c.scope_id=$1 AND c.collection_key=ANY($2::text[])))
          UNION ALL SELECT s.* FROM authority.scope_instance s JOIN descendants d ON s.parent_id=d.id
        ) SELECT id FROM descendants WHERE NOT is_terminal ORDER BY id`, [source.owner.id, cancellation_keys]);
        const provided = (request.child_cancellations ?? []).map((item) => item.source.owner.id).sort();
        if (JSON.stringify(expected.map((item) => item.id)) !== JSON.stringify(provided)) fail({ kind: "Rejected", reason: "invalid", detail: "declared child cancellation set differs from active descendants" });
      }
      for (const child of request.child_cancellations ?? []) {
        if (!child.request.decision || child.request.decision.kind !== "apply" || !child.request.decision.outcome || JSON.stringify(child.request.read_set) !== JSON.stringify(request.read_set))
          fail({ kind: "Rejected", reason: "invalid", detail: "child cancellation must terminate against the parent read set" });
        const valid = validateDecision(child.request, child.source);
        const authority = valid.ok ? await validateStorageAuthority(tx, child.request, child.source, definition.source) : valid;
        if (!authority.ok) fail({ kind: "Rejected", reason: "invalid", detail: authority.error.detail });
        const descendants = await tx.query<{ id: string }>(`WITH RECURSIVE descendants AS (
          SELECT id,parent_id FROM authority.scope_instance WHERE parent_id=$1
          UNION ALL SELECT s.id,s.parent_id FROM authority.scope_instance s JOIN descendants d ON s.parent_id=d.id
        ) SELECT id FROM descendants WHERE id=$2`, [request.identity.scope_id, child.source.owner.id]);
        if (!descendants.length || child.source.owner.run_id !== source.owner.run_id || child.source.owner.is_terminal)
          fail({ kind: "Rejected", reason: "invalid", detail: "cancellation target is not an active owned descendant" });
        await writeDecision(tx, child.request, child.source, definition);
      }
      const committed = await writeDecision(tx, request, source, definition);
      await measureWrittenSnapshots(tx, source, request.child_cancellations, definition);
      return { kind: "Committed", receipt: committed };
    });
    return { ok: true, value: result };
  } catch (error) {
    if (error instanceof AbortCommit) return { ok: true, value: error.outcome };
    const mapped = databaseFailure(error);
    if (mapped) return { ok: true, value: mapped };
    return { ok: false, error: { operation: "commit_decision", entity_id: request.identity.scope_id, detail: String(error) } };
  }
}
