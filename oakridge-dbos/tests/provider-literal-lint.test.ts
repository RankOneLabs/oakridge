import { expect, test } from "bun:test";
import { resolve } from "node:path";
import ts from "typescript";
import { HANDLE_KINDS, PROVIDER_ERROR_CODES } from "../src/effects/provider-catalog";
import { OPERATION_REGISTRY } from "../src/operations/registry";

interface LiteralViolation { readonly file: string; readonly line: number; readonly value: string }
/** The two declaration modules: the provider catalog and the operation registry. */
const DECLARATIONS = new Set(["effects/provider-catalog.ts", "operations/registry.ts"]);
/** The executor's own code; an operation's module may name its reader's error kinds (`auth`), which are not attempt codes. */
const SCANNED = ["effects", "workflows", "adapters"];
const restricted = new Set<string>([
  ...Object.values(HANDLE_KINDS), ...Object.values(PROVIDER_ERROR_CODES), ...OPERATION_REGISTRY.map((operation) => operation.key),
]);

function literalViolations(file: string, source: string): LiteralViolation[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: LiteralViolation[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && restricted.has(node.text)) {
      violations.push({ file, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, value: node.text });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return violations;
}

test("handle, operation and failure-code literals live only in their declaration modules", async () => {
  const root = resolve(import.meta.dir, "../src");
  const violations: LiteralViolation[] = [];
  for (const directory of SCANNED) for await (const file of new Bun.Glob(`${directory}/**/*.ts`).scan({ cwd: root })) {
    if (DECLARATIONS.has(file)) continue;
    violations.push(...literalViolations(file, await Bun.file(resolve(root, file)).text()));
  }
  expect(violations).toEqual([]);
});

test("the lint detects each forbidden literal class", () => {
  const examples = [HANDLE_KINDS.session, OPERATION_REGISTRY[0].key, PROVIDER_ERROR_CODES.head_changed];
  expect(examples.map((value) => literalViolations("other.ts", `const value = ${JSON.stringify(value)};`).length)).toEqual([1, 1, 1]);
});
