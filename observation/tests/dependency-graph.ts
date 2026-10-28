import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

export interface ModuleNode {
  readonly path: string;
  readonly imports: readonly string[];
  readonly packages: readonly string[];
}
export type ModuleGraph = ReadonlyMap<string, ModuleNode>;
export interface BoundaryViolation { readonly path: string; readonly detail: string }

function parseModule(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}
export function importNames(file: string, source: string): readonly string[] {
  const names: string[] = [];
  const parsed = parseModule(file, source);
  function visit(node: ts.Node): void {
    // Type-only imports count: extraction fails on those dependencies too.
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) names.push(node.moduleReference.expression.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(parsed) === "require")) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument)) throw new Error(`unresolved dynamic import: ${file}`);
      names.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return names;
}

/** Checks both package specifiers and resolved relative imports. */
export function observationBoundaryViolations(nodes: readonly ModuleNode[], repositoryRoot: string): readonly BoundaryViolation[] {
  const forbiddenRoots = ["oakridge-dbos", "kbbl"].map((name) => resolve(repositoryRoot, name));
  const isForbiddenPath = (path: string): boolean => forbiddenRoots.some((root) => path === root || path.startsWith(`${root}/`));
  const isForbiddenPackage = (name: string): boolean => /(^|\/)(oakridge-dbos|kbbl)(\/|$)/.test(name);
  return nodes.flatMap((node) => [
    ...(isForbiddenPath(node.path) ? [{ path: node.path, detail: "observation reaches a forbidden package" }] : []),
    ...node.imports.filter(isForbiddenPath).map((path) => ({ path: node.path, detail: `observation imports ${relative(repositoryRoot, path)}` })),
    ...node.packages.filter(isForbiddenPackage).map((name) => ({ path: node.path, detail: `observation imports ${name}` })),
  ]);
}
export function buildGraph(entries: readonly string[]): ModuleGraph {
  const graph = new Map<string, ModuleNode>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (!file || graph.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const names = importNames(file, source);
    const imports = names.filter((name) => name.startsWith(".")).map((name) => {
      const base = resolve(dirname(file), name);
      const found = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]
        .find((path) => existsSync(path) && statSync(path).isFile());
      if (!found) throw new Error(`unresolved active import: ${file} -> ${name}`);
      return found;
    });
    graph.set(file, { path: file, imports, packages: names.filter((name) => !name.startsWith(".")) });
    queue.push(...imports);
  }
  return graph;
}
export function reachable(graph: ModuleGraph, from: string): readonly ModuleNode[] {
  const visited = new Set<string>();
  const queue = [from];
  const result: ModuleNode[] = [];
  while (queue.length) {
    const path = queue.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const node = graph.get(path);
    if (!node) throw new Error(`missing graph node: ${path}`);
    result.push(node);
    queue.push(...node.imports);
  }
  return result;
}
