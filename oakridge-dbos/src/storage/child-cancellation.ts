import type { CoreClient } from "../core-client/client";
import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { Result, CommitRequest } from "./commit";
import type { MutationInput, Decision } from "./mutation-service";
import { prepareCommit, requestEvaluation } from "./mutation-service";
import { readSnapshot, type AuthoritySnapshot } from "./snapshot-reader";
import type { ScopeInstanceRecord } from "./schema-records";
import type { TransactionalSqlExecutor } from "./sql-executor";

export interface ChildCancellation { readonly source: AuthoritySnapshot; readonly request: CommitRequest }

/** Core decisions for declared descendants share the parent's full expected read set. */
export async function prepareChildCancellations(db: TransactionalSqlExecutor, core: CoreClient, bundle: DefinitionBundle,
  input: MutationInput, decision: Decision): Promise<Result<readonly ChildCancellation[]>> {
  if (decision.outcome.kind !== "apply") return { ok: true, value: [] };
  const keys = decision.outcome.mutations.flatMap((mutation) => mutation.kind === "cancel_children" ? [mutation.key] : []);
  if (!keys.length) return { ok: true, value: [] };
  const owner = bundle.scopes.find((scope) => scope.key === decision.source.owner.scope_key);
  if (!owner) return failure(input.scope_id, "parent definition missing");
  const scopes = await db.query<ScopeInstanceRecord>(`WITH RECURSIVE descendants AS (
    SELECT s.*,0 AS depth FROM authority.scope_instance s WHERE s.parent_id=$1
    AND ((s.collection_key IS NULL AND s.child_key=ANY($2::text[])) OR s.id IN (SELECT COALESCE(member->>'id', member#>>'{}') FROM authority.child_collection c,
      jsonb_array_elements(c.members) member WHERE c.scope_id=$1 AND c.collection_key=ANY($2::text[])))
    UNION ALL SELECT s.*,d.depth+1 FROM authority.scope_instance s JOIN descendants d ON s.parent_id=d.id
  ) SELECT * FROM descendants ORDER BY depth DESC,id`, [input.scope_id, keys]);
  const cancellations: ChildCancellation[] = [];
  for (const scope of scopes) {
    if (scope.is_terminal) continue;
    const declaration = bundle.scopes.find((item) => item.key === scope.scope_key);
    const key = declaration?.cancellation.trigger;
    const event = declaration?.commands.find((item) => item.key === key) ?? declaration?.facts.find((item) => item.key === key);
    if (!key || !event) return failure(scope.id, "configured cancellation trigger missing");
    const checked = await core.request("validate_payload", { bundle, schema: event.payload_schema, payload: {} });
    if (!checked.ok || checked.value.kind !== "validated") return failure(scope.id, "cancellation requires a valid empty record payload");
    const id = `${input.ingress_id}:cancel:${scope.id}`;
    const trigger = { id, key, payload: checked.value.value };
    const source = await readSnapshot(db, scope.id as import("./schema-records").ScopeId, trigger);
    if (!source) return failure(scope.id, "cancellation owner missing");
    if (JSON.stringify(source.read_set) !== JSON.stringify(decision.source.read_set)) return failure(scope.id, "cancellation snapshot changed; retry parent decision");
    const evaluated = await requestEvaluation(core, { bundle, source });
    if (!evaluated.ok || evaluated.value.kind !== "evaluated" || evaluated.value.value.kind !== "apply" || !evaluated.value.value.outcome)
      return failure(scope.id, "configured cancellation must select a terminal decision");
    const request = prepareCommit({ run_id: input.run_id, scope_id: scope.id as import("./schema-records").ScopeId, ingress_id: id, trigger, operator_version: null }, { source, outcome: evaluated.value.value });
    if (!request.ok) return request;
    cancellations.push({ source, request: request.value });
  }
  return { ok: true, value: cancellations };
}
function failure(entity_id: string, detail: string): Result<never> {
  return { ok: false, error: { operation: "prepare_child_cancellation", entity_id, detail } };
}
