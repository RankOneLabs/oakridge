import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const readModelFields = [
  ["OperatorRunView", ["run_id", "definition_id", "definition_id", "created_at", "archived_at", "status", "units"]],
  ["OperatorRunSummary", ["run_id", "definition_id", "definition_id", "created_at", "archived_at", "status"]],
  ["OperatorUnitView", ["unit_id", "run_id", "unit_key", "status", "attention", "decisions", "attempts", "artifacts"]],
  ["OperatorArtifactDetail", ["run_id", "unit_id", "artifact_key", "schema", "status", "revisions", "decisions"]],
  ["OperatorInboxPage", ["items", "next_cursor"]],
] as const;

function inlineReadModel(node: ts.ObjectLiteralExpression): string | null {
  const fields = new Set(node.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
    return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? [property.name.text] : [];
  }));
  return readModelFields.find(([, required]) => required.every((field) => fields.has(field)))?.[0] ?? null;
}

test("PWA read-model fixtures are constructed only in the shared factory", () => {
  const root = resolve(import.meta.dir, "../../kbbl/core/pwa");
  const models = new Set<string>(readModelFields.map(([name]) => name));
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(directory, entry.name)) : /\.(?:test|spec)\.tsx?$/.test(entry.name) ? [resolve(directory, entry.name)] : []);
  for (const file of files(root)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && ts.isVariableDeclaration(node.parent) && !node.parent.type) {
        const model = inlineReadModel(node);
        if (model) throw new Error(`${file}: construct ${model} with __fixtures__/read-models.ts`);
      }
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)
        && node.type && ts.isTypeReferenceNode(node.type) && models.has(node.type.typeName.getText(source)))
        throw new Error(`${file}: construct ${node.type.typeName.getText(source)} with __fixtures__/read-models.ts`);
      if ((ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) && ts.isObjectLiteralExpression(node.expression)
        && ts.isTypeReferenceNode(node.type) && models.has(node.type.typeName.getText(source)))
        throw new Error(`${file}: construct ${node.type.typeName.getText(source)} with __fixtures__/read-models.ts`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test("read-model fixture lint recognizes inline untyped literals", () => {
  for (const [name, fields] of readModelFields) {
    const source = ts.createSourceFile("inline.ts", `const value = { ${fields.map((field) => `${field}: null`).join(", ")} };`, ts.ScriptTarget.Latest, true);
    const statement = source.statements[0];
    if (!statement || !ts.isVariableStatement(statement)) throw new Error("test fixture declaration missing");
    const literal = statement.declarationList.declarations[0]?.initializer;
    if (!literal || !ts.isObjectLiteralExpression(literal)) throw new Error("test fixture literal missing");
    expect(inlineReadModel(literal)).toBe(name);
  }
});

