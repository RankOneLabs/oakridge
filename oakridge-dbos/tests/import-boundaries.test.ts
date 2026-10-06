import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");
interface ModuleNode { readonly path: string; readonly source: string; readonly imports: readonly string[]; readonly packages: readonly string[] }
type ModuleGraph = ReadonlyMap<string, ModuleNode>;

function importNames(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) names.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(parsed) === "require")
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) names.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return names;
}
function resolveImport(file: string, name: string): string {
  const base = resolve(dirname(file), name);
  const found = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")].find(existsSync);
  if (!found) throw new Error(`unresolved active import: ${relative(root, file)} -> ${name}`);
  return found;
}
function buildGraph(entries: readonly string[]): ModuleGraph {
  const graph = new Map<string, ModuleNode>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const names = importNames(file, source);
    const imports = names.filter((name) => name.startsWith(".")).map((name) => resolveImport(file, name));
    const packages = names.filter((name) => !name.startsWith("."));
    graph.set(file, { path: file, source, imports, packages });
    queue.push(...imports);
  }
  return graph;
}
function reachable(graph: ModuleGraph, from: string): ModuleNode[] {
  const visited = new Set<string>();
  const queue = [from];
  const result: ModuleNode[] = [];
  while (queue.length) {
    const path = queue.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const node = graph.get(path);
    if (!node) throw new Error(`missing dependency graph node: ${path}`);
    result.push(node);
    queue.push(...node.imports);
  }
  return result;
}
const dbosMain = resolve(root, "oakridge-dbos/src/main.ts");
const pwaMain = resolve(root, "kbbl/core/pwa/main.tsx");
const graph = buildGraph([dbosMain, pwaMain]);
const label = (path: string) => relative(root, path);

function projectionViolations(nodes: readonly ModuleNode[]): string[] {
  return nodes.flatMap((node) => {
    const forbiddenPackage = node.packages.filter((name) => /^(node:(fs|net|http|https|child_process|crypto)|pg$|@dbos-inc\/)/.test(name));
    const forbiddenCall = /\b(fetch|Bun\.spawn|Date\.now|crypto\.randomUUID)\s*\(/.test(node.source);
    return [...forbiddenPackage.map((name) => `${label(node.path)} -> ${name}`), ...(forbiddenCall ? [`${label(node.path)} calls external IO`] : [])];
  });
}
test("active projection graph has no network, filesystem, process, clock or random IO", () => {
  const projections = [...graph.values()].filter((node) => label(node.path).startsWith("oakridge-dbos/src/projections/"));
  expect(projections.length).toBeGreaterThan(0);
  for (const projection of projections) {
    const closure = reachable(graph, projection.path).filter((node) => !label(node.path).startsWith("oakridge-dbos/src/storage/"));
    expect(projectionViolations(closure)).toEqual([]);
  }
});
test("a reachable injected projection IO dependency fails the boundary assertion", () => {
  const injected: ModuleNode = { path: resolve(root, "oakridge-dbos/src/projections/injected.ts"), source: "fetch('https://example.test')", imports: [], packages: [] };
  const synthetic = new Map(graph);
  synthetic.set(injected.path, injected);
  const start = resolve(root, "oakridge-dbos/src/projections/inbox.ts");
  synthetic.set(start, { ...synthetic.get(start)!, imports: [...synthetic.get(start)!.imports, injected.path] });
  expect(projectionViolations(reachable(synthetic, start))).toContain(`${label(injected.path)} calls external IO`);
});
test("active HTTP handlers, adapters and observers do not write authority SQL directly", () => {
  const subjects = [...graph.values()].filter((node) => /^oakridge-dbos\/src\/(http|adapters|effects\/operations)\//.test(label(node.path)));
  expect(subjects.length).toBeGreaterThan(0);
  const violations = subjects.filter((node) => /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+authority\./i.test(node.source)).map((node) => label(node.path));
  expect(violations).toEqual([]);
});
test("active PWA graph cannot import backend workflow authority", () => {
  const paths = reachable(graph, pwaMain).map((node) => label(node.path));
  expect(paths.filter((path) => path.startsWith("oakridge-dbos/src/") || path.startsWith("kbbl/core/server/"))).toEqual([]);
});

function rustLibraryGraph(): string[] {
  const queue = ["model", "compiler", "evaluator"].map((name) => resolve(root, `workflow-core/crates/${name}/src/lib.rs`));
  const seen = new Set<string>();
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) {
      if (match[1] === "tests") continue;
      const module = resolve(dirname(file), `${match[1]}.rs`);
      if (!existsSync(module)) throw new Error(`unresolved Rust library module: ${label(file)} -> ${match[1]}`);
      queue.push(module);
    }
  }
  return [...seen];
}
test("reachable Rust library modules and Cargo dependencies have no external IO capability", () => {
  const files = rustLibraryGraph();
  expect(files.length).toBeGreaterThan(10);
  const forbiddenApi = /\b(?:std::(?:fs|net|process|env|time|thread)|tokio::|reqwest::|ureq::|rand::|getrandom::|chrono::|SystemTime|Instant::now|std::io::(?:stdin|stdout|stderr))\b/;
  expect(files.filter((file) => forbiddenApi.test(readFileSync(file, "utf8"))).map(label)).toEqual([]);
  const packages = ["model", "compiler", "evaluator"];
  const forbiddenCrate = /^\s*(?:tokio|reqwest|ureq|rand|getrandom|chrono|postgres|sqlx|rusqlite|diesel)\s*=/m;
  expect(packages.filter((name) => forbiddenCrate.test(readFileSync(resolve(root, `workflow-core/crates/${name}/Cargo.toml`), "utf8")))).toEqual([]);
});
test("Rust interpreter branches contain no workflow-specific identifiers", () => {
  const names = /\b(?:dev_flow|development|spec|plan|brief|build|assessment|final_integration)\b/;
  const violations = rustLibraryGraph().flatMap((file) => readFileSync(file, "utf8").split("\n")
    .filter((line) => /\b(?:if|match)\b|=>/.test(line) && names.test(line) && /["']/.test(line))
    .map((line) => `${label(file)}: ${line.trim()}`));
  expect(violations).toEqual([]);
});
