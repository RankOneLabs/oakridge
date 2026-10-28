import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { buildGraph, importNames, observationBoundaryViolations, reachable, type ModuleGraph, type ModuleNode } from "./dependency-graph";

const repositoryRoot = resolve(import.meta.dir, "../..");
const foundationEntry = resolve(import.meta.dir, "../src/index.ts");
const serviceEntry = resolve(import.meta.dir, "../src/main.ts");
const graph = buildGraph([foundationEntry, serviceEntry]);

function inject(graph: ModuleGraph, source: string): ModuleGraph {
  const nodePath = resolve(import.meta.dir, "../src/injected.ts");
  const owner = graph.get(serviceEntry);
  if (!owner) throw new Error("missing service entry");
  const names = importNames(nodePath, source);
  const node: ModuleNode = { path: nodePath, imports: [], packages: names };
  const result = new Map(graph);
  result.set(nodePath, node);
  result.set(serviceEntry, { ...owner, imports: [...owner.imports, nodePath] });
  return result;
}

for (const entry of [foundationEntry, serviceEntry]) {
  test(`${entry === serviceEntry ? "running service" : "foundation"} reaches no oakridge-dbos or kbbl modules`, () => {
    expect(observationBoundaryViolations(reachable(graph, entry), repositoryRoot)).toEqual([]);
  });
}
test("running service reaches storage, HTTP, and ingest modules", () => {
  const reached = reachable(graph, serviceEntry).map((node) => node.path);
  for (const module of ["storage/capture-store.ts", "http/sources.ts", "ingest/capture.ts"])
    expect(reached).toContain(resolve(import.meta.dir, `../src/${module}`));
});
for (const packageName of ["oakridge-dbos", "kbbl"]) {
  test(`a reachable import of ${packageName} violates the boundary`, () => {
    const bad = inject(graph, `import ${JSON.stringify(`${packageName}/src/main.ts`)};`);
    expect(observationBoundaryViolations(reachable(bad, serviceEntry), repositoryRoot)).toContainEqual({
      path: resolve(import.meta.dir, "../src/injected.ts"), detail: `observation imports ${packageName}/src/main.ts`,
    });
  });
  test(`type-only imports of ${packageName} also violate the boundary`, () => {
    const bad = inject(graph, `import type { Example } from ${JSON.stringify(`${packageName}/example`)};`);
    expect(observationBoundaryViolations(reachable(bad, serviceEntry), repositoryRoot).length).toBeGreaterThan(0);
  });
}

test("running grading service imports only its declared local infrastructure packages", () => {
  const allowed = new Set(["hono", "kysely", "pg", "zod"]);
  const external = reachable(graph, serviceEntry).flatMap((node) => node.packages)
    .filter((name) => !name.startsWith("node:") && !name.startsWith("bun:"));
  expect(external.filter((name) => !allowed.has(name))).toEqual([]);
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"));
  expect(Object.keys(manifest.dependencies).sort()).toEqual([...allowed].sort());
  for (const forbidden of ["langfuse", "openai", "@anthropic-ai/sdk", "@google/generative-ai", "jig", "assay"])
    expect(external).not.toContain(forbidden);
});

test("grading ports do not depend on storage modules", () => {
  for (const name of ["grade-runner", "evaluation-backend", "artifact-source", "experiment-exporter"]) {
    const entry = resolve(import.meta.dir, `../src/ports/${name}.ts`);
    const portGraph = buildGraph([entry]);
    expect(reachable(portGraph, entry).some((node) => node.path.includes("/storage/"))).toBe(false);
  }
});
