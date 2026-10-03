import { expect, test } from "bun:test";
import { resolve } from "node:path";
import ts from "typescript";

interface SourceText { readonly path: string; readonly text: string }
interface ArtifactRefDerivation { readonly path: string; readonly owner: string | null }

// Inspect syntax and local symbols, so formatting, casts, shorthand properties,
// and renamed destructured fields cannot conceal a second identity mapping.
const artifactRefDerivations = (sources: readonly SourceText[]): readonly ArtifactRefDerivation[] => {
  const options: ts.CompilerOptions = { noResolve: true, noLib: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path, languageVersion) => {
    const source = sources.find((entry) => entry.path === path);
    return source ? ts.createSourceFile(path, source.text, languageVersion, true) : undefined;
  };
  const program = ts.createProgram(sources.map((source) => source.path), options, host);
  const checker = program.getTypeChecker();
  const found: ArtifactRefDerivation[] = [];
  const readsField = (node: ts.Node, field: string, seen = new Set<ts.Symbol>()): boolean => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === field) return true;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === field) return true;
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (symbol && !seen.has(symbol)) {
        seen.add(symbol);
        for (const declaration of symbol.declarations ?? []) {
          if (ts.isBindingElement(declaration)) {
            const key = declaration.propertyName ?? declaration.name;
            if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === field) return true;
          }
          if (ts.isVariableDeclaration(declaration) && declaration.initializer && readsField(declaration.initializer, field, seen)) return true;
        }
      }
    }
    return ts.forEachChild(node, (child) => readsField(child, field, seen) || undefined) === true;
  };
  const propertyValue = (object: ts.ObjectLiteralExpression, key: string): ts.Node | undefined => {
    const property = object.properties.find((entry) => entry.name && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === key);
    return property && ts.isPropertyAssignment(property) ? property.initializer
      : property && ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
  };
  const ownerOf = (node: ts.Node): string | null => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isFunctionDeclaration(parent)) return parent.name?.text ?? null;
    }
    return null;
  };
  for (const source of program.getSourceFiles()) {
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const id = propertyValue(node, "id");
        const version = propertyValue(node, "version");
        if (id && version && readsField(id, "chain_id") && readsField(version, "revision")) found.push({ path: source.fileName, owner: ownerOf(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
};

test("artifactRefFromRevision is the only chain/revision identity derivation under src", async () => {
  const root = resolve(import.meta.dir, "../src");
  const paths = [...new Bun.Glob("**/*.ts").scanSync({ cwd: root })].sort();
  const sources = await Promise.all(paths.map(async (path) => ({ path: resolve(root, path), text: await Bun.file(resolve(root, path)).text() })));
  expect(artifactRefDerivations(sources)).toEqual([{ path: resolve(root, "domain/dev-flow-v15.ts"), owner: "artifactRefFromRevision" }]);
});

for (const [name, source] of [
  ["direct mapping", "const duplicate = (artifact) => ({ id: artifact.chain_id, version: artifact.revision });"],
  ["reordered bracket access with a cast", "function duplicate(a) { return { version: a['revision'], id: a['chain_id'] } as ArtifactRef; }"],
  ["renamed destructured fields", "const duplicate = ({ chain_id: id, revision: version }) => ({ id, version });"],
  ["local aliases", "function duplicate(a) { const id = a.chain_id; const version = a.revision; return { id, version }; }"],
] as const) {
  test(`the identity guard detects a second derivation using ${name}`, () => {
    expect(artifactRefDerivations([{ path: "/duplicate.ts", text: source }])).toEqual([{ path: "/duplicate.ts", owner: "duplicate" }]);
  });
}

test("the identity guard permits calls to the canonical transform and unrelated revision records", () => {
  const text = "const ref = artifactRefFromRevision(artifact); const row = { chain_id: artifact.chain_id, revision: artifact.revision };";
  expect(artifactRefDerivations([{ path: "/consumer.ts", text }])).toEqual([]);
});
