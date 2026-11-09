import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
  const allowed = new Set(["canonical-json", "hono", "kysely", "pg", "zod"]);
  const external = reachable(graph, serviceEntry).flatMap((node) => node.packages)
    .filter((name) => !name.startsWith("node:") && !name.startsWith("bun:"));
  expect(external.filter((name) => !allowed.has(name))).toEqual([]);
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"));
  expect(Object.keys(manifest.dependencies).sort()).toEqual([...allowed].sort());
  for (const forbidden of ["langfuse", "openai", "@anthropic-ai/sdk", "@google/generative-ai", "jig", "assay"])
    expect(external).not.toContain(forbidden);
});

test("grading ports do not depend on storage modules", () => {
  for (const name of ["grade-runner", "artifact-source", "producer-profile"]) {
    const entry = resolve(import.meta.dir, `../src/ports/${name}.ts`);
    const portGraph = buildGraph([entry]);
    expect(reachable(portGraph, entry).some((node) => node.path.includes("/storage/"))).toBe(false);
  }
});

const sourceRoot = resolve(import.meta.dir, "../src");
const producerRoot = resolve(sourceRoot, "producers");
const compositionRoot = resolve(sourceRoot, "main.ts");
function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") || path.endsWith(".sql") ? [path] : [];
  });
}
const coreFiles = sourceFiles(sourceRoot).filter((path) => !path.startsWith(`${producerRoot}/`));

/** A concept is matched inside identifiers too: `cohortId`, `cohort_id`, `spec_ref`, `BriefBody`. */
const NAMED_CONCEPT = /cohort|brief|criterion|finding/i;
const SPEC_CONCEPT = /(?:^|[^a-zA-Z])[Ss]pec(?:[^a-zA-Z]|$)|[a-z]Spec(?:[^a-z]|$)/;
const namesProducerConcept = (line: string): boolean => NAMED_CONCEPT.test(line) || SPEC_CONCEPT.test(line);

for (const path of coreFiles.filter((file) => file.endsWith(".ts") && file !== compositionRoot)) {
  test(`${relative(sourceRoot, path)} does not reach a producer implementation`, () => {
    const moduleGraph = buildGraph([path]);
    expect(reachable(moduleGraph, path).map((node) => node.path).filter((reached) => reached.startsWith(`${producerRoot}/`))).toEqual([]);
  });
}

test("only the composition root names a producer implementation", () => {
  const importers = coreFiles.filter((path) => path.endsWith(".ts")
    && importNames(path, readFileSync(path, "utf8")).some((name) => name.includes("producers/")));
  expect(importers).toEqual([compositionRoot]);
});

test("core code, tables and rules never name a producer concept", () => {
  const named = coreFiles.flatMap((path) => readFileSync(path, "utf8").split("\n")
    .flatMap((line, index) => namesProducerConcept(line) ? [`${relative(sourceRoot, path)}:${index + 1}: ${line.trim()}`] : []));
  expect(named).toEqual([]);
});

test("the vocabulary check sees a concept inside an identifier", () => {
  for (const line of ["const cohort_id = 1", "interface BriefBody {", "readonly spec_ref: string", "const criterionScope = 1", "input.spec", "isFinding()", "taskSpec"])
    expect({ line, matched: namesProducerConcept(line) }).toEqual({ line, matched: true });
  for (const line of ["inspect the response", "specific kind", "a respectful test"]) expect({ line, matched: namesProducerConcept(line) }).toEqual({ line, matched: false });
});

test("core hard-codes no producer item kind or artifact selection", () => {
  const selecting = /["'](assessment|assessment_finding|analysis|plan|build_result|task)["']/;
  const named = coreFiles.filter((path) => selecting.test(readFileSync(path, "utf8"))).map((path) => relative(sourceRoot, path));
  expect(named).toEqual([]);
});

test("a stray producer import in core is detected", () => {
  const source = 'import { oakridgeProfile } from "../producers/oakridge/profile";';
  const names = importNames(resolve(sourceRoot, "storage/injected.ts"), source);
  expect(names.some((name) => name.includes("producers/"))).toBe(true);
});
