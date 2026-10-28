import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

export interface ModuleNode {
  readonly path: string;
  readonly source: string;
  readonly imports: readonly string[];
  readonly packages: readonly string[];
}
export type ModuleGraph = ReadonlyMap<string, ModuleNode>;
export interface BoundaryViolation { readonly path: string; readonly detail: string }

export function parseModule(file: string, source: string): ts.SourceFile {
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
    graph.set(file, { path: file, source, imports, packages: names.filter((name) => !name.startsWith(".")) });
    queue.push(...imports);
  }
  return graph;
}
export function reachable(graph: ModuleGraph, from: string, barriers: ReadonlySet<string> = new Set()): readonly ModuleNode[] {
  const visited = new Set<string>();
  const queue = [from];
  const result: ModuleNode[] = [];
  while (queue.length) {
    const path = queue.pop();
    if (!path || visited.has(path) || barriers.has(path)) continue;
    visited.add(path);
    const node = graph.get(path);
    if (!node) throw new Error(`missing graph node: ${path}`);
    result.push(node);
    queue.push(...node.imports);
  }
  return result;
}

export function projectionViolations(nodes: readonly ModuleNode[]): readonly BoundaryViolation[] {
  return nodes.flatMap((node) => {
    const violations: BoundaryViolation[] = node.packages.map((name) => ({ path: node.path, detail: `projection imports external runtime package ${name}` }));
    const parsed = parseModule(node.path, node.source);
    function visit(child: ts.Node): void {
      // A type annotation naming Date is not a call to the clock.
      if (ts.isIdentifier(child) && !ts.isTypeReferenceNode(child.parent) && ["fetch", "Bun", "Deno", "Date", "crypto", "process", "performance", "setTimeout", "setInterval", "XMLHttpRequest", "EventSource"].includes(child.text))
        violations.push({ path: node.path, detail: `projection references IO capability ${child.text}` });
      if (ts.isPropertyAccessExpression(child) && child.expression.getText(parsed) === "Math" && child.name.text === "random")
        violations.push({ path: node.path, detail: "projection references IO capability Math.random" });
      if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
        const call = child.expression.getText(parsed);
        if (/^(fetch|Bun\.|Date\b|crypto\.|process\.)/.test(call) || /\.(query|transaction|request|unsafe|connect|spawn|readFile|writeFile|now|random|randomUUID)$/.test(call))
          violations.push({ path: node.path, detail: `projection calls IO capability ${call}` });
      }
      ts.forEachChild(child, visit);
    }
    visit(parsed);
    return violations;
  });
}
/** Core `compile`/`step` calls outside the approved modules: commit steps, the core client compiles. */
export function evaluatorViolations(nodes: readonly ModuleNode[], mutationNodes: ReadonlySet<string>): readonly BoundaryViolation[] {
  return nodes.flatMap((node) => {
    const violations: BoundaryViolation[] = [];
    const parsed = parseModule(node.path, node.source);
    function visit(child: ts.Node): void {
      if (ts.isCallExpression(child) && child.arguments[0] && ts.isStringLiteral(child.arguments[0])
        && ["compile", "step"].includes(child.arguments[0].text)
        && child.expression.getText(parsed).endsWith(".request") && !mutationNodes.has(node.path))
        violations.push({ path: node.path, detail: "core call outside commit and the core client" });
      ts.forEachChild(child, visit);
    }
    visit(parsed);
    return violations;
  });
}
export function declarations(nodes: readonly ModuleNode[], name: string): readonly string[] {
  return nodes.flatMap((node) => {
    const found: string[] = [];
    function visit(child: ts.Node): void {
      if ((ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child) || ts.isVariableDeclaration(child)) && child.name?.getText() === name) found.push(node.path);
      ts.forEachChild(child, visit);
    }
    visit(parseModule(node.path, node.source));
    return found;
  });
}
export function labels(root: string, violations: readonly BoundaryViolation[]): readonly string[] {
  return violations.map((violation) => `${relative(root, violation.path)}: ${violation.detail}`);
}

export function evaluationCallSites(nodes: readonly ModuleNode[]): readonly string[] {
  return nodes.flatMap((node) => {
    const paths: string[] = [];
    const parsed = parseModule(node.path, node.source);
    function visit(child: ts.Node): void {
      if (ts.isCallExpression(child) && child.arguments[0] && ts.isStringLiteral(child.arguments[0])
        && child.arguments[0].text === "step" && child.expression.getText(parsed).endsWith(".request")) paths.push(node.path);
      ts.forEachChild(child, visit);
    }
    visit(parsed);
    return paths;
  });
}
