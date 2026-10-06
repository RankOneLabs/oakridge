import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
import ts from "typescript";
const root = resolve(import.meta.dir, "../..");
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}
function imports(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) names.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) names.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names;
}
function dependencies(path: string): string[] {
  return imports(path).filter((name) => name.startsWith(".")).map((name) => {
    const base = resolve(dirname(path), name);
    const found = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]
      .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    if (!found) throw new Error(`Unresolved PWA import: ${path} -> ${name}`);
    return found;
  });
}
test("the entire PWA import graph stays outside backend workflow modules", () => {
  const queue = sourceFiles(resolve(root, "kbbl/core/pwa"));
  const seen = new Set<string>();
  const violations: string[] = [];
  while (queue.length) {
    const path = queue.pop();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    for (const dependency of dependencies(path)) {
      if (dependency.startsWith(resolve(root, "oakridge-dbos/src")) || dependency.startsWith(resolve(root, "kbbl/core/server")))
        violations.push(`${path.slice(root.length + 1)} -> ${dependency.slice(root.length + 1)}`);
      else if ([".ts", ".tsx"].includes(extname(dependency))) queue.push(dependency);
    }
  }
  expect(violations).toEqual([]);
});

test("the operator surface has no imports of deleted modules", () => {
  const operatorFiles = sourceFiles(resolve(root, "kbbl/core/pwa/oakridge"));
  for (const file of operatorFiles) dependencies(file);
  expect(operatorFiles.length).toBeGreaterThan(0);
});
