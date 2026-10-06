import type { DecisionTree, Expression, ReferenceRoot, ScopeDefinition } from "./generated-contracts";

/** Root identity is independent of source JSON property ordering. */
export function observationRootKey(root: ReferenceRoot): string {
  return JSON.stringify([root.kind, "key" in root ? root.key : null, "worker" in root ? root.worker : null,
    "export" in root ? root.export : null, "schema" in root ? root.schema : null]);
}

/** Roots are declared by checked source expressions, never inferred from business names. */
export function selectObservationRoots(scope: ScopeDefinition): readonly ReferenceRoot[] {
  const roots = new Map<string, ReferenceRoot>();
  const expression = (value: Expression): void => {
    switch (value.kind) {
      case "reference": roots.set(observationRootKey(value.root), value.root); break;
      case "record": value.fields.forEach((field) => expression(field.value)); break;
      case "list": value.items.forEach(expression); break;
      case "variant": expression(value.value); break;
      case "equals": expression(value.left); expression(value.right); break;
      case "all": case "any": value.items.forEach(expression); break;
      case "is_variant": case "not": expression(value.value); break;
      case "optional": if (value.value) expression(value.value); break;
      case "field": expression(value.value); break;
      case "filter_by": expression(value.source); expression(value.key); break;
      case "contains": expression(value.source); expression(value.value); break;
      case "lookup": expression(value.source); expression(value.key); break;
      case "map": expression(value.source); expression(value.value); break;
      case "filter": case "every": expression(value.source); expression(value.predicate); break;
      case "check_collection": case "unique_by": expression(value.source); break;
      case "literal": break;
    }
  };
  const tree = (value: DecisionTree): void => {
    switch (value.kind) {
      case "match": expression(value.value); value.cases.forEach((item) => tree(item.node)); if (value.otherwise) tree(value.otherwise); break;
      case "if": expression(value.condition); tree(value.then); tree(value.otherwise); break;
      case "apply": value.mutations.forEach((item) => { if (item.kind === "set_state" || item.kind === "export" || item.kind === "bind_resource") expression(item.value); }); if (value.outcome) expression(value.outcome); break;
      case "wait": case "reject": break;
    }
  };
  tree(scope.tree);
  scope.workers.forEach((worker) => worker.actions.forEach((action) => expression(action.input)));
  scope.commands.forEach((command) => command.targets.forEach(expression));
  scope.children.forEach((child) => { expression(child.input); if (child.collection) expression(child.collection.source); });
  return [...roots.values()];
}
