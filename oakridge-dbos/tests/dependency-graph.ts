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
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (node.importClause?.name || !bindings || !ts.isNamedImports(bindings) || bindings.elements.some((item) => !item.isTypeOnly)) names.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some((item) => !item.isTypeOnly)) names.push(node.moduleSpecifier.text);
    }
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

/** Inspect SQL literals in each reachable module, including helpers and template SQL. */
export function writtenAuthorityTables(node: ModuleNode): readonly string[] {
  const tables: string[] = [];
  const parsed = parseModule(node.path, node.source);
  function visit(child: ts.Node): void {
    if (ts.isStringLiteralLike(child) || ts.isTemplateExpression(child)) {
      const text = ts.isTemplateExpression(child) ? child.getText(parsed) : child.text;
      for (const match of text.matchAll(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+["']?authority["']?\s*\.\s*["']?([\w]+|\$\{)/gi)) {
        if (match[1]) tables.push(match[1]);
      }
    }
    ts.forEachChild(child, visit);
  }
  visit(parsed);
  return tables;
}
function opaqueSqlCalls(node: ModuleNode): readonly BoundaryViolation[] {
  // The executor is the transport boundary; statement inspection happens at its callers.
  if (node.path.endsWith("/storage/sql-executor.ts")) return [];
  const parsed = parseModule(node.path, node.source);
  const literalMaps = new Set<string>();
  function collect(child: ts.Node): void {
    if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer && ts.isObjectLiteralExpression(child.initializer)
      && child.initializer.properties.every((property) => ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer))) literalMaps.add(child.name.text);
    ts.forEachChild(child, collect);
  }
  collect(parsed);
  const violations: BoundaryViolation[] = [];
  function visit(child: ts.Node): void {
    if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === "query") {
      const sql = child.arguments[0];
      const isLiteralMap = sql && ts.isElementAccessExpression(sql) && ts.isIdentifier(sql.expression) && literalMaps.has(sql.expression.text);
      if (!sql || !(ts.isStringLiteralLike(sql) || ts.isTemplateExpression(sql) || isLiteralMap))
        violations.push({ path: node.path, detail: "unresolved SQL statement bypasses mutation service" });
    }
    ts.forEachChild(child, visit);
  }
  visit(parsed);
  return violations;
}
export function mutationViolations(graph: ModuleGraph, entries: readonly string[], mutationEntry: string): readonly BoundaryViolation[] {
  const subjects = new Map(entries.flatMap((entry) => reachable(graph, entry, new Set([mutationEntry]))).map((node) => [node.path, node]));
  return [...subjects.values()].flatMap((node) => [...opaqueSqlCalls(node), ...writtenAuthorityTables(node)
    // Effect-intent leases, handles and delivery bookkeeping belong to the IO ledger.
    // Every other authority table is domain state and crosses the mutation entry.
    .filter((table) => table !== "effect_intent")
    .map((table) => ({ path: node.path, detail: `domain write to authority.${table} bypasses mutation service` }))]);
}
export function projectionViolations(nodes: readonly ModuleNode[]): readonly BoundaryViolation[] {
  return nodes.flatMap((node) => {
    const violations: BoundaryViolation[] = node.packages.map((name) => ({ path: node.path, detail: `projection imports external runtime package ${name}` }));
    const parsed = parseModule(node.path, node.source);
    function visit(child: ts.Node): void {
      if (ts.isIdentifier(child) && ["fetch", "Bun", "Deno", "Date", "crypto", "process", "performance", "setTimeout", "setInterval", "XMLHttpRequest", "EventSource"].includes(child.text))
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
const retiredRequestKinds = new Set([
  "accept_analysis", "accept_plan", "revise_analysis", "revise_plan", "accept_briefs", "revise_briefs",
  "accept_build", "replace_pr", "request_build_changes", "accept_assessment", "discuss_assessment",
  "request_implementation_changes", "confirm_merged", "closed_without_merge", "retry_provision", "retry_analysis",
  "retry_plan", "retry_briefs", "retry_build", "retry_assessment", "retry_final_integration", "cancel", "abandon",
]);
export function closedCommandViolations(nodes: readonly ModuleNode[]): readonly BoundaryViolation[] {
  return nodes.flatMap((node) => {
    const parsed = parseModule(node.path, node.source);
    const violations: BoundaryViolation[] = [];
    function visit(child: ts.Node): void {
      if (ts.isPropertyAssignment(child) && child.name.getText(parsed) === "kind" && ts.isStringLiteral(child.initializer)
        && retiredRequestKinds.has(child.initializer.text)) violations.push({ path: node.path, detail: `retired workflow request constructor ${child.initializer.text}` });
      if (ts.isTypeAliasDeclaration(child) && ts.isUnionTypeNode(child.type)) {
        const variants = child.type.types.filter(ts.isTypeLiteralNode);
        // A request carrying workflow targets/feedback beside finite kind values
        // is the removed protocol. Descriptor keys remain open strings.
        const isRequest = /Request|WorkflowChange/.test(child.name.text) || variants.some((variant) => variant.members.some((member) =>
          ts.isPropertySignature(member) && ["feedback", "target"].includes(member.name.getText(parsed))));
        if (isRequest && variants.some((variant) => variant.members.some((member) => ts.isPropertySignature(member)
          && member.name.getText(parsed) === "kind" && member.type && (ts.isLiteralTypeNode(member.type) || ts.isUnionTypeNode(member.type)))))
          violations.push({ path: node.path, detail: `closed workflow command type ${child.name.text}` });
      }
      if (ts.isStringLiteralLike(child) || ts.isTemplateExpression(child)) {
        if (/\/cohorts\//.test(child.getText(parsed))) violations.push({ path: node.path, detail: "removed cohort endpoint" });
      }
      ts.forEachChild(child, visit);
    }
    visit(parsed);
    return violations;
  });
}
export function evaluatorViolations(nodes: readonly ModuleNode[], mutationNodes: ReadonlySet<string>): readonly BoundaryViolation[] {
  return nodes.flatMap((node) => {
    const violations: BoundaryViolation[] = [];
    const parsed = parseModule(node.path, node.source);
    function visit(child: ts.Node): void {
      if (ts.isCallExpression(child) && child.arguments[0] && ts.isStringLiteral(child.arguments[0])
        && ["compile", "evaluate"].includes(child.arguments[0].text)
        && child.expression.getText(parsed).endsWith(".request") && !mutationNodes.has(node.path))
        violations.push({ path: node.path, detail: "evaluator call bypasses mutation service" });
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
        && child.arguments[0].text === "evaluate" && child.expression.getText(parsed).endsWith(".request")) paths.push(node.path);
      ts.forEachChild(child, visit);
    }
    visit(parsed);
    return paths;
  });
}
