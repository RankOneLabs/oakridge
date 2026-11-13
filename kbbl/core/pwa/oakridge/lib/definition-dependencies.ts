import type { OperatorAuthoredWorkflow, OperatorWorkflow, OperatorGroup, OperatorUnit } from "../operator-contracts/core-client/core-types";

export type DependencyBinding = { kind: "input"; field: string } | { kind: "for_each" } | { kind: "key" };
export interface DependencyReference { downstream: string; binding: DependencyBinding; upstream: string; outcome_path: readonly string[] }
export type DependencyEdge = { kind: "explicit"; from: string; to: string } | { kind: "referenced"; from: string; to: string; references: readonly DependencyReference[] };
export interface PerMemberAfter { unit: string; expression: string }
export interface DefinitionDependencies { references: DependencyReference[]; edges: DependencyEdge[]; per_member_after: PerMemberAfter[] }
interface BindingExpression { binding: DependencyBinding; expression: string }

function selectBindings(unit: OperatorUnit): BindingExpression[] {
  return [
    ...Object.entries(unit.input ?? {}).map(([field, expression]): BindingExpression => ({ binding: { kind: "input", field }, expression })),
    ...(unit.for_each ? [{ binding: { kind: "for_each" } as const, expression: unit.for_each }] : []),
    ...(unit.key ? [{ binding: { kind: "key" } as const, expression: unit.key }] : []),
  ];
}

/** Only sibling identifiers establish dependencies; strings and dotted field names do not. */
function selectExpressionPaths(expression: string, sibling: string): string[][] {
  const lexical = expression.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (quoted) => " ".repeat(quoted.length));
  const escaped = sibling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const outcome = new RegExp(`(?<![\\w.])${escaped}\\.outcome((?:\\.[A-Za-z_][A-Za-z_0-9]*)*)`, "g");
  const paths = [...lexical.matchAll(outcome)].map((match) => (match[1] ?? "").split(".").filter(Boolean));
  const bare = new RegExp(`(?<![\\w.])(?:map|contains)\\s*\\(\\s*${escaped}\\s*[,)]`, "g");
  for (const match of lexical.matchAll(bare)) {
    const argument = lexical.slice((match.index ?? 0) + match[0].length).split(/[,)\n]/)[0] ?? "";
    // Only the paired argument replaces a bare reference with a specific outcome path.
    const paired = new RegExp(`(?<![\\w.])${escaped}\\.outcome(?:\\.[A-Za-z_][A-Za-z_0-9]*)*`);
    if (!paired.test(argument)) paths.push([]);
  }
  return paths;
}

export function selectDefinitionDependencies(workflow: OperatorWorkflow | OperatorAuthoredWorkflow): DefinitionDependencies {
  const result: DefinitionDependencies = { references: [], edges: [], per_member_after: [] };
  const seen = new Set<string>();
  function scan(group: OperatorGroup, prefix: string): void {
    const path = (key: string) => prefix ? `${prefix}/${key}` : key;
    for (const [key, unit] of Object.entries(group.units)) {
      const downstream = path(key);
      if (typeof unit.after === "string") result.per_member_after.push({ unit: downstream, expression: unit.after });
      else for (const upstream of unit.after ?? []) {
        if (upstream !== key && upstream in group.units) result.edges.push({ kind: "explicit", from: path(upstream), to: downstream });
      }
      for (const { binding, expression } of selectBindings(unit)) {
        for (const sibling of Object.keys(group.units).filter((sibling) => sibling !== key)) {
          for (const outcome_path of selectExpressionPaths(expression, sibling)) {
            const reference: DependencyReference = { downstream, binding, upstream: path(sibling), outcome_path };
            const identity = JSON.stringify(reference);
            if (seen.has(identity)) continue;
            seen.add(identity);
            result.references.push(reference);
          }
        }
      }
      if (unit.group) scan(unit.group, downstream);
    }
  }
  scan(workflow.run, "");
  const pairs = new Map<string, DependencyReference[]>();
  for (const reference of result.references) {
    const pair = JSON.stringify([reference.upstream, reference.downstream]);
    const references = pairs.get(pair) ?? [];
    references.push(reference);
    pairs.set(pair, references);
  }
  for (const references of pairs.values()) {
    const first = references[0];
    if (first) result.edges.push({ kind: "referenced", from: first.upstream, to: first.downstream, references });
  }
  return result;
}
