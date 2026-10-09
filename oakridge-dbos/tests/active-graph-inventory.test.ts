import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { buildGraph, reachable, declarations, evaluatorViolations, evaluationCallSites, labels } from "./dependency-graph";

const root = resolve(import.meta.dir, "../..");
const entry = resolve(root, "oakridge-dbos/src/main.ts");
const graph = buildGraph([entry]);
const nodes = reachable(graph, entry);
const files = nodes.map((node) => relative(root, node.path));
const deleted = [
  "kbbl/core/pwa/oakridge/review-command-types.ts", "kbbl/core/pwa/oakridge/lib/worker-review-actions.ts",
  "kbbl/core/pwa/oakridge/components/organisms/RunWorkspace.tsx", "kbbl/core/acp/legacy-wire.ts", "oakridge-dbos/src/compiler/compile-v15.ts", "oakridge-dbos/src/decision",
  "oakridge-dbos/src/validation", "oakridge-dbos/src/adapters/dev-flow.ts",
];
test("production entry reaches one evaluator bridge and one mutation authority", () => {
  expect(files).toContain("oakridge-dbos/src/core-client/client.ts");
  const mutationEntry = resolve(root, "oakridge-dbos/src/storage/mutation-service.ts");
  expect(evaluationCallSites(nodes)).toEqual([mutationEntry]);
  expect(declarations(nodes, "CoreClient")).toEqual([resolve(root, "oakridge-dbos/src/core-client/client.ts")]);
  expect(declarations(nodes, "createMutationService")).toEqual([mutationEntry]);
  const mutationNodes = new Set(reachable(graph, mutationEntry).map((node) => node.path));
  expect(labels(root, evaluatorViolations(nodes, mutationNodes))).toEqual([]);
  expect(files.filter((path) => /(?:legacy-wire|compile-v15|\/decision\/|\/validation\/|dev-flow\.ts)/.test(path))).toEqual([]);
});
test("deleted modules and legacy schema authority are absent from the active graph", () => {
  expect(deleted.filter((path) => existsSync(resolve(root, path)))).toEqual([]);
  expect(files.filter((path) => path.startsWith("kbbl/core/db/") || path.includes("/migrations/") && !path.startsWith("oakridge-dbos/src/storage/migrations/"))).toEqual([]);
});
test("active schema and symbols reflect the scope authority", () => {
  const sql = readFileSync(resolve(root, "oakridge-dbos/src/storage/migrations/0001_core_authority.sql"), "utf8");
  const tables = [...sql.matchAll(/CREATE TABLE\s+([\w.]+)/g)].map((match) => match[1]);
  expect(tables).toEqual([
    "authority.schema_baseline",
    "authority.definition_bundle", "authority.prompt_content", "authority.run", "authority.scope_instance", "authority.launch_receipt", "authority.scope_export",
    "authority.child_collection", "authority.execution_selection", "authority.execution", "authority.artifact_revision",
    "authority.output_slot", "authority.fact", "authority.transition", "authority.ingress_receipt",
    "authority.effect_intent", "authority.capacity_pool", "authority.capacity_reservation", "authority.resource_binding", "authority.project",
  ]);
  const activeSource = files.map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");
  expect(activeSource).toContain("createMutationService");
  expect(activeSource).toContain("createProductionComposition");
  expect(activeSource).not.toMatch(/CREATE\s+TABLE\s+oakridge\./i);
});

test("a second mutation authority declaration fails the symbol inventory", () => {
  const duplicate = { path: resolve(root, "oakridge-dbos/src/injected.ts"), source: "export function createMutationService() {}", imports: [], packages: [] };
  expect(declarations([...nodes, duplicate], "createMutationService")).toHaveLength(2);
});
