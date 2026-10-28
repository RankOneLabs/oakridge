import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildGraph, importNames, observationBoundaryViolations, reachable, type ModuleGraph, type ModuleNode } from "./dependency-graph";

const repositoryRoot = resolve(import.meta.dir, "../..");
const entry = resolve(import.meta.dir, "../src/index.ts");
const graph = buildGraph([entry]);

function inject(graph: ModuleGraph, source: string): ModuleGraph {
  const nodePath = resolve(import.meta.dir, "../src/injected.ts");
  const owner = graph.get(entry);
  if (!owner) throw new Error("missing service entry");
  const names = importNames(nodePath, source);
  const node: ModuleNode = { path: nodePath, source, imports: [], packages: names };
  const result = new Map(graph);
  result.set(nodePath, node);
  result.set(entry, { ...owner, imports: [...owner.imports, nodePath] });
  return result;
}

test("the service entry reaches no oakridge-dbos or kbbl modules", () => {
  expect(observationBoundaryViolations(reachable(graph, entry), repositoryRoot)).toEqual([]);
});
for (const packageName of ["oakridge-dbos", "kbbl"]) {
  test(`a reachable import of ${packageName} violates the boundary`, () => {
    const bad = inject(graph, `import ${JSON.stringify(`${packageName}/src/main.ts`)};`);
    expect(observationBoundaryViolations(reachable(bad, entry), repositoryRoot)).toContainEqual({
      path: resolve(import.meta.dir, "../src/injected.ts"), detail: `observation imports ${packageName}/src/main.ts`,
    });
  });
  test(`type-only imports of ${packageName} also violate the boundary`, () => {
    const bad = inject(graph, `import type { Example } from ${JSON.stringify(`${packageName}/example`)};`);
    expect(observationBoundaryViolations(reachable(bad, entry), repositoryRoot).length).toBeGreaterThan(0);
  });
}
