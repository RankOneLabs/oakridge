import type { DecisionOutcome } from "../core-client/generated-contracts";
import type { AuthoritySnapshot } from "./snapshot-reader";
import type { CommitRequest, Result } from "./commit";
import type { DefinitionBundle, OutputDefinition } from "../core-client/generated-contracts";
import type { SqlExecutor } from "./sql-executor";

function reject(operation: string, entity_id: string, detail: string): Result<never> {
  return { ok: false, error: { operation, entity_id, detail } };
}
export function validateDecision(request: CommitRequest, source: AuthoritySnapshot): Result<CommitRequest> {
  if (request.identity.scope_id !== source.owner.id || request.identity.run_id !== source.owner.run_id) return reject("validate_commit", source.owner.id, "owner mismatch");
  if (!request.decision || typeof request.decision !== "object" || !["apply", "wait", "reject"].includes(request.decision.kind)) return reject("validate_commit", source.owner.id, "malformed decision outcome");
  if (request.decision.kind === "apply") {
    if (!Array.isArray(request.decision.mutations) || !Array.isArray(request.decision.invocations)) return reject("validate_commit", source.owner.id, "malformed core mutations");
    for (const mutation of request.decision.mutations) {
      if (!mutation || typeof mutation !== "object" || typeof mutation.kind !== "string") return reject("validate_commit", source.owner.id, "malformed mutation");
      switch (mutation.kind) {
        case "set_state": if (!mutation.value) return reject("validate_commit", source.owner.id, "state value missing"); break;
        case "activate_child": if (!mutation.key || !mutation.input) return reject("validate_commit", source.owner.id, "malformed child activation"); break;
        case "activate_collection": if (!mutation.key || !mutation.materialization || !Array.isArray(mutation.materialization.children)) return reject("validate_commit", source.owner.id, "malformed collection activation"); break;
        case "export": if (!mutation.key || !mutation.value) return reject("validate_commit", source.owner.id, "malformed export"); break;
        case "acquire": case "release": if (!mutation.pool) return reject("validate_commit", source.owner.id, "malformed capacity mutation"); break;
        case "revoke": case "stop": if (!mutation.worker) return reject("validate_commit", source.owner.id, "worker missing"); break;
        case "observe": if (!mutation.resource) return reject("validate_commit", source.owner.id, "resource missing"); break;
        default: return reject("validate_commit", source.owner.id, "unknown mutation kind");
      }
    }
    for (const invocation of request.decision.invocations) if (!invocation?.selection?.worker || !invocation.input) return reject("validate_commit", source.owner.id, "malformed invocation");
  }
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

export async function validateStorageAuthority(tx: SqlExecutor, request: CommitRequest, source: AuthoritySnapshot): Promise<Result<CommitRequest>> {
  const bundles = await tx.query<{ source: DefinitionBundle }>("SELECT b.source FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1", [source.owner.run_id]);
  const scope = bundles[0]?.source.scopes.find((item) => item.key === source.owner.scope_key);
  if (!scope) return reject("validate_storage", source.owner.id, "scope definition missing");
  if (request.decision.kind === "apply") for (const mutation of request.decision.mutations) {
    if (mutation.kind === "activate_child" && !scope.children.some((child) => child.key === mutation.key)) return reject("validate_storage", source.owner.id, "child declaration missing");
    if (mutation.kind === "activate_collection" && (!scope.children.some((child) => child.key === mutation.key && child.collection) || mutation.materialization.children.some((child) => !bundles[0]!.source.scopes.some((candidate) => candidate.key === child.scope)))) return reject("validate_storage", source.owner.id, "collection declaration missing");
    if (mutation.kind === "export" && !scope.exports.some((item) => item.key === mutation.key)) return reject("validate_storage", source.owner.id, "export declaration missing");
  }
  for (const output of request.outputs) {
    const definition: OutputDefinition | undefined = scope.outputs.find((item) => item.key === output.output_key);
    if (!definition) return reject("validate_storage", source.owner.id, "output is absent from scope definition");
    if (!!definition.collection_key !== !!output.collection_key) return reject("validate_storage", source.owner.id, "collection identity mismatch");
    if (output.execution_id) {
      const executions = await tx.query<{ scope_id: string; worker_key: string; generation: string | number }>("SELECT scope_id,worker_key,generation FROM authority.execution WHERE id=$1", [output.execution_id]);
      const execution = executions[0];
      if (!execution || execution.scope_id !== source.owner.id || !definition.producers.includes(execution.worker_key)) return reject("validate_storage", source.owner.id, "execution cannot publish this output");
      const selections = await tx.query<{ execution_id: string; generation: string | number }>("SELECT execution_id,generation FROM authority.execution_selection WHERE scope_id=$1 AND worker_key=$2", [source.owner.id, execution.worker_key]);
      if (selections[0]?.execution_id !== output.execution_id || Number(selections[0]?.generation) !== Number(execution.generation)) return reject("validate_storage", source.owner.id, "execution generation was revoked");
    } else if (definition.producers.length) return reject("validate_storage", source.owner.id, "producer execution required");
  }
  for (const change of request.capacity) {
    const owned = source.pools.find((item) => item.id === change.pool_id && item.run_id === source.owner.run_id);
    if (!owned) return reject("validate_storage", source.owner.id, "capacity pool belongs to another run");
  }
  return { ok: true, value: request };
}

export function isDecisionOutcome(value: unknown): value is DecisionOutcome {
  return !!value && typeof value === "object" && "kind" in value && (value.kind === "apply" || value.kind === "wait" || value.kind === "reject");
}
