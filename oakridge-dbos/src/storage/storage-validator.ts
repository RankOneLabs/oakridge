import { CORE_PROTOCOL_VERSION, decodeCoreResponse } from "../core-client/generated-contracts";
import type { DecisionOutcome } from "../core-client/generated-contracts";
import type { AuthoritySnapshot } from "./snapshot-reader";
import type { CommitRequest, CommitRejectionReason, Result } from "./commit";
import type { DefinitionBundle, OutputDefinition } from "../core-client/generated-contracts";
import type { SqlExecutor } from "./sql-executor";

function reject(operation: string, entity_id: string, detail: string, reason?: CommitRejectionReason): Result<never> {
  return { ok: false, error: { operation, entity_id, detail, reason } };
}
export function validateDecision(request: CommitRequest, source: AuthoritySnapshot): Result<CommitRequest> {
  if (request.identity.scope_id !== source.owner.id || request.identity.run_id !== source.owner.run_id) return reject("validate_commit", source.owner.id, "owner mismatch");
  if (!isDecisionOutcome(request.decision)) return reject("validate_commit", source.owner.id, "malformed decision outcome");
  if (!Array.isArray(request.outputs) || !Array.isArray(request.capacity) || !Array.isArray(request.effects)) return reject("validate_commit", source.owner.id, "malformed commit writes");
  if (request.decision.kind === "apply" && request.decision.mutations.some((mutation) => mutation.kind === "observe")) return reject("validate_commit", source.owner.id, "observe requires a resource observation provider; unsupported by this composition");
  if (request.outputs.some((output) => output.scope_id !== source.owner.id || output.output_key.length === 0)) return reject("validate_commit", source.owner.id, "output ownership mismatch");
  if (request.capacity.some((change) => change.scope_id !== source.owner.id)) return reject("validate_commit", source.owner.id, "capacity ownership mismatch");
  if (request.decision.kind === "apply") for (const mutation of request.decision.mutations) {
    if (mutation.kind === "acquire" || mutation.kind === "release") {
      const pool = source.pools.find((item) => item.pool_key === mutation.pool);
      if (!pool || !request.capacity.some((item) => item.pool_id === pool.id && item.kind === mutation.kind)) return reject("validate_commit", source.owner.id, "capacity mutation lacks matching owned pool reservation");
    }
  }
  return { ok: true, value: request };
}

export async function validateStorageAuthority(tx: SqlExecutor, request: CommitRequest, source: AuthoritySnapshot, pinned_bundle?: DefinitionBundle): Promise<Result<CommitRequest>> {
  const bundle = pinned_bundle ?? (await tx.query<{ source: DefinitionBundle }>("SELECT b.source FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [source.owner.run_id]))[0]?.source;
  const scope = bundle?.scopes.find((item) => item.key === source.owner.scope_key);
  if (!bundle || !scope) return reject("validate_storage", source.owner.id, "scope definition missing");
  if (request.decision.kind === "apply") {
    for (const mutation of request.decision.mutations) {
      if (mutation.kind === "bind_resource" || mutation.kind === "clear_resource") {
        const declaration = scope.resources.find((resource) => resource.key === mutation.key);
        if (!declaration) return reject("validate_storage", source.owner.id, "resource declaration missing");
      }
      if (mutation.kind === "clear_output" && !scope.outputs.some((output) => output.key === mutation.key)) return reject("validate_storage", source.owner.id, "output clearing undeclared");
      if (mutation.kind === "cancel_children" && !scope.children.some((child) => child.key === mutation.key)) return reject("validate_storage", source.owner.id, "child cancellation undeclared");
      if (mutation.kind === "activate_child" || mutation.kind === "activate_collection") {
        const declared = scope.children.find((child) => child.key === mutation.key);
        const child_scope = bundle.scopes.find((child) => child.key === declared?.scope);
        if (!declared || !child_scope) return reject("validate_storage", source.owner.id, "child declaration missing");
        if (mutation.kind === "activate_child" && declared.collection) return reject("validate_storage", source.owner.id, "child activation kind mismatch");
        if (mutation.kind === "activate_collection") {
          if (!declared.collection || mutation.materialization.children.some((child) => child.scope !== declared.scope)) return reject("validate_storage", source.owner.id, "collection scope mismatch");
          if (new Set(mutation.materialization.children.map((child) => child.key)).size !== mutation.materialization.children.length) return reject("validate_storage", source.owner.id, "duplicate collection member");
        }
      }
      if (mutation.kind === "export") {
        const declared = scope.exports.find((item) => item.key === mutation.key);
        if (!declared) return reject("validate_storage", source.owner.id, "export declaration missing");
      }
      if ((mutation.kind === "revoke" || mutation.kind === "stop") && !scope.workers.some((worker) => worker.key === mutation.worker)) return reject("validate_storage", source.owner.id, "worker declaration missing");
      if ((mutation.kind === "acquire" || mutation.kind === "release") && !scope.pools.some((pool) => pool.key === mutation.pool)) return reject("validate_storage", source.owner.id, "pool declaration missing");
    }
    for (const invocation of request.decision.invocations) {
      const action = scope.workers.find((worker) => worker.key === invocation.selection.worker)?.actions.find((action) => action.key === invocation.selection.action);
      if (!action) return reject("validate_storage", source.owner.id, "invocation declaration missing");
      const contract = invocation.definition;
      const has_matching_contract = contract.operation === action.operation && contract.contract_version === action.contract_version
        && contract.input_schema === action.input_schema
        && contract.deadline_ms === action.deadline_ms && contract.max_attempts === action.max_attempts
        && JSON.stringify(contract.outputs) === JSON.stringify(action.outputs)
        && JSON.stringify(contract.settings) === JSON.stringify(action.settings)
        && JSON.stringify(contract.tools) === JSON.stringify(action.tools)
        && (invocation.prompt_key ?? null) === (action.prompt ?? null);
      if (!has_matching_contract) return reject("validate_storage", source.owner.id, "invocation contract differs from stored action");
    }
  }
  if (request.execution_authority) {
    const selected = await tx.query<{ execution_id: string }>("SELECT execution_id FROM authority.execution_selection WHERE scope_id=$1 AND execution_id=$2", [source.owner.id, request.execution_authority]);
    if (!selected.length) return reject("validate_storage", source.owner.id, "execution generation was revoked", "generation_revoked");
  }
  const is_operator_edit = request.operator_version !== null && scope.outputs.some((output) => output.operator_edit_trigger === source.snapshot.trigger.key);
  if (is_operator_edit && !request.outputs.some((output) => output.execution_id === null))
    return reject("validate_storage", source.owner.id, "operator edit requires an output publication");
  if (is_operator_edit) {
    const active = await tx.query<{ id: string }>(`SELECT e.id FROM authority.execution_selection s
      JOIN authority.execution e ON e.id=s.execution_id
      WHERE s.scope_id=$1 AND e.status='pending' LIMIT 1`, [source.owner.id]);
    if (active.length) return reject("validate_storage", source.owner.id, "operator edit requires completed executions");
  }
  for (const output of request.outputs) {
    const definition: OutputDefinition | undefined = scope.outputs.find((item) => item.key === output.output_key);
    if (!definition) return reject("validate_storage", source.owner.id, "output is absent from scope definition");
    if (output.execution_id !== null && definition.publication_trigger !== source.snapshot.trigger.key) return reject("validate_storage", source.owner.id, "publication trigger does not match output declaration");
    if (output.execution_id === null && request.operator_version !== null && definition.operator_edit_trigger !== source.snapshot.trigger.key)
      return reject("validate_storage", source.owner.id, "operator edit trigger does not match output declaration");
    if (definition.collection_key) {
      const shape = bundle.schemas.find((schema) => schema.key === definition.schema)?.shape;
      const index = shape?.kind === "record" ? shape.fields.findIndex((field) => field.key === definition.collection_key) : -1;
      const key = output.body.data.kind === "record" ? output.body.data.fields.find((field) => field.field_id === index)?.value : null;
      if (key?.data.kind !== "string" || key.data.value !== output.collection_key) return reject("validate_storage", source.owner.id, "collection body key mismatch");
    }
    if (!!definition.collection_key !== !!output.collection_key) return reject("validate_storage", source.owner.id, "collection identity mismatch");
    if (output.execution_id) {
      const executions = await tx.query<{ scope_id: string; worker_key: string; generation: string | number }>("SELECT scope_id,worker_key,generation FROM authority.execution WHERE id=$1", [output.execution_id]);
      const execution = executions[0];
      if (!execution || execution.scope_id !== source.owner.id || !definition.producers.includes(execution.worker_key)) return reject("validate_storage", source.owner.id, "execution cannot publish this output");
      const selections = await tx.query<{ execution_id: string; generation: string | number }>("SELECT execution_id,generation FROM authority.execution_selection WHERE scope_id=$1 AND worker_key=$2", [source.owner.id, execution.worker_key]);
      if (selections[0]?.execution_id !== output.execution_id || Number(selections[0]?.generation) !== Number(execution.generation)) return reject("validate_storage", source.owner.id, "execution generation was revoked", "generation_revoked");
      const contracts = await tx.query<{ payload: import("../effects/intents").EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1 AND execution_id=$2 AND payload->>'action'='start'", [source.owner.id, output.execution_id]);
      if (!contracts.some((item) => item.payload.invocation.selection.definition.outputs.includes(output.output_key))) return reject("validate_storage", source.owner.id, "selected action does not declare this output");
    } else if (request.operator_version === null && definition.producers.length) return reject("validate_storage", source.owner.id, "producer execution required");
  }
  for (const change of request.capacity) {
    const owned = source.pools.find((item) => item.id === change.pool_id && item.run_id === source.owner.run_id);
    if (!owned) return reject("validate_storage", source.owner.id, "capacity pool belongs to another run");
  }
  return { ok: true, value: request };
}

export function isDecisionOutcome(value: unknown): value is DecisionOutcome {
  return decodeCoreResponse({ version: CORE_PROTOCOL_VERSION, request_id: "storage-validation", truncated: false, result: { status: "ok", value: { kind: "evaluated", value } } }) !== null;
}
