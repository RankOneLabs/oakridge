import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");
const entry = resolve(root, "oakridge-dbos/src/main.ts");
function activeFiles(): string[] {
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const parsed = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      let name: string | null = null;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) name = node.moduleSpecifier.text;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) name = node.argument.literal.text;
      if (name?.startsWith(".")) {
        const base = resolve(dirname(file), name);
        const resolved = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")].find(existsSync);
        if (!resolved) throw new Error(`unresolved active import: ${relative(root, file)} -> ${name}`);
        queue.push(resolved);
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
  return [...seen].map((file) => relative(root, file));
}
const files = activeFiles();
const deleted = [
  "kbbl/core/acp/legacy-wire.ts", "oakridge-dbos/src/compiler/compile-v15.ts", "oakridge-dbos/src/decision",
  "oakridge-dbos/src/validation", "oakridge-dbos/src/workflows", "oakridge-dbos/src/adapters/dev-flow.ts",
];
test("production entry reaches one evaluator bridge and one mutation authority", () => {
  expect(files).toContain("oakridge-dbos/src/core-client/client.ts");
  expect(files).toContain("oakridge-dbos/src/storage/mutation-service.ts");
  expect(files.filter((path) => /(?:legacy-wire|compile-v15|\/decision\/|\/validation\/|\/workflows\/|dev-flow\.ts)/.test(path))).toEqual([]);
});
test("deleted modules and legacy schema authority are absent from the active graph", () => {
  expect(deleted.filter((path) => existsSync(resolve(root, path)))).toEqual([]);
  expect(files.filter((path) => path.startsWith("kbbl/core/db/") || path.includes("/migrations/") && !path.startsWith("oakridge-dbos/src/storage/migrations/"))).toEqual([]);
});
test("active schema and symbols reflect the scope authority", () => {
  const sql = readFileSync(resolve(root, "oakridge-dbos/src/storage/migrations/0001_core_authority.sql"), "utf8");
  const tables = [...sql.matchAll(/CREATE TABLE\s+([\w.]+)/g)].map((match) => match[1]);
  expect(tables).toEqual([
    "authority.definition_bundle", "authority.run", "authority.scope_instance", "authority.scope_export",
    "authority.child_collection", "authority.execution_selection", "authority.execution", "authority.artifact_revision",
    "authority.output_slot", "authority.fact", "authority.transition", "authority.ingress_receipt",
    "authority.effect_intent", "authority.capacity_pool", "authority.capacity_reservation", "authority.resource_binding",
  ]);
  const activeSource = files.map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");
  expect(activeSource).toContain("createMutationService");
  expect(activeSource).toContain("createProductionComposition");
  expect(activeSource).not.toMatch(/CREATE\s+TABLE\s+oakridge\./i);
});
