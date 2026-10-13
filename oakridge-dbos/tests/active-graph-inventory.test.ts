import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { buildGraph, reachable, declarations, evaluatorViolations, evaluationCallSites, labels } from "./dependency-graph";

const root = resolve(import.meta.dir, "../..");
const entry = resolve(root, "oakridge-dbos/src/main.ts");
const graph = buildGraph([entry]);
const nodes = reachable(graph, entry);
const files = nodes.map((node) => relative(root, node.path));
test("production entry reaches one core bridge and one writer", () => {
  expect(files).toContain("oakridge-dbos/src/core-client/client.ts");
  const commit = resolve(root, "oakridge-dbos/src/storage/commit.ts");
  expect(evaluationCallSites(nodes)).toEqual([commit]);
  expect(declarations(nodes, "CoreClient")).toEqual([resolve(root, "oakridge-dbos/src/core-client/client.ts")]);
  expect(declarations(nodes, "commitEvent")).toEqual([commit]);
  expect(labels(root, evaluatorViolations(nodes, new Set([commit, resolve(root, "oakridge-dbos/src/core-client/client.ts")])))).toEqual([]);
});
test("the kbbl ledger and other schemas are absent from the authority's graph", () => {
  expect(files.filter((path) => path.startsWith("kbbl/core/db/") || path.includes("/migrations/") && !path.startsWith("oakridge-dbos/src/storage/migrations/"))).toEqual([]);
});
test("active schema and symbols reflect the authority", () => {
  const sql = readFileSync(resolve(root, "oakridge-dbos/src/storage/migrations/0001_core.sql"), "utf8");
  const tables = [...sql.matchAll(/CREATE TABLE\s+([\w.]+)/g)].map((match) => match[1]);
  expect(tables).toEqual([
    "authority.schema_baseline",
    "authority.definition_bundle", "authority.project", "authority.prompt_content", "authority.run", "authority.unit",
    "authority.unit_dependency", "authority.attempt", "authority.artifact_revision", "authority.review_decision",
    "authority.event", "authority.wanted_log", "authority.effect_intent", "authority.ingress_receipt",
    "authority.collaboration_thread",
    "authority.collaboration_message", "authority.review_item", "authority.collaboration_delivery", "authority.operator_event",
  ]);
  const activeSource = files.map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");
  expect(activeSource).toContain("commitEvent");
  expect(activeSource).toContain("createProductionComposition");
  expect(activeSource).not.toMatch(/CREATE\s+TABLE\s+oakridge\./i);
});

test("a second writer declaration fails the symbol inventory", () => {
  const duplicate = { path: resolve(root, "oakridge-dbos/src/injected.ts"), source: "export function commitEvent() {}", imports: [], packages: [] };
  expect(declarations([...nodes, duplicate], "commitEvent")).toHaveLength(2);
});
