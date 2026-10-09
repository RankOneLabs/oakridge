import type { FieldExpression, Schema, ScopeDefinition } from "../source-contracts";

export interface RunPolicy {
  readonly key: string;
  readonly implementation_capacity: number;
  readonly sibling_failure: "cancel" | "continue_independent";
  readonly contract_field_order: "canonical" | "alternate";
  readonly stage_layout?: "standard" | "verification";
}
export const DEVELOPMENT_POLICY: RunPolicy = {
  key: "development", implementation_capacity: 4,
  sibling_failure: "cancel", contract_field_order: "canonical",
};
export const INDEPENDENT_SIBLINGS_POLICY: RunPolicy = {
  key: "development-independent-siblings", implementation_capacity: 2,
  sibling_failure: "continue_independent", contract_field_order: "alternate",
};
export const VERIFICATION_POLICY: RunPolicy = {
  key: "development-verification", implementation_capacity: 3,
  sibling_failure: "cancel", contract_field_order: "alternate", stage_layout: "verification",
};

/** The alternate bundle also exercises provider decoding with reordered fields. */
const ALTERNATE_FIELD_ORDER: ReadonlyMap<string, readonly string[]> = new Map([
  ["repo_result", ["repository_path", "head", "push_remote_owner"]],
  ["pr_query", ["owner", "name", "head_branch", "base_branch", "head_owner"]],
]);
function orderFields<Field extends { readonly key: string }>(fields: Field[], order: readonly string[]): Field[] {
  // Unknown fields keep their relative order; selecting by name survives inserted declarations.
  return [...order.flatMap((key) => fields.filter((field) => field.key === key)),
    ...fields.filter((field) => !order.includes(field.key))];
}
export function configureSchemas(schemas: Schema[], policy: RunPolicy): Schema[] {
  if (policy.contract_field_order === "canonical") return schemas;
  return schemas.map((schema) => {
    const order = ALTERNATE_FIELD_ORDER.get(schema.key);
    return order && schema.shape.kind === "record"
      ? { ...schema, shape: { ...schema.shape, fields: orderFields(schema.shape.fields, order) } } : schema;
  });
}
function configureObserver(scope: ScopeDefinition, policy: RunPolicy): ScopeDefinition {
  if (policy.contract_field_order === "canonical") return scope;
  return { ...scope, workers: scope.workers.map((worker) => {
    if (worker.key !== "pr_observer") return worker;
    return { ...worker, actions: worker.actions.map((action) => {
      if (action.input.kind !== "record" || action.input.schema !== "pr_observe_input") return action;
      const fields: FieldExpression[] = action.input.fields.map((field) => {
        if (field.key !== "query" || field.value.kind !== "record") return field;
        const order = ALTERNATE_FIELD_ORDER.get(field.value.schema);
        return order ? { ...field, value: { ...field.value, fields: orderFields(field.value.fields, order) } } : field;
      });
      return { ...action, input: { ...action.input, fields } };
    }) };
  }) };
}
export function configureScope(scope: ScopeDefinition, policy: RunPolicy): ScopeDefinition {
  if (scope.key === "development") return scope;
  const configured = configureObserver(scope, policy);
  if (scope.key !== "implementation") return configured;
  return { ...configured, pools: configured.pools.map((pool) => pool.key === "implementation_slots"
    ? { ...pool, limit: policy.implementation_capacity } : pool) };
}
