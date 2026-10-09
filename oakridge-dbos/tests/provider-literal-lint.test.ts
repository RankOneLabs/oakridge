import { expect, test } from "bun:test";
import { resolve } from "node:path";
import ts from "typescript";
import { INPUT_CONTRACTS, PROVIDER_CATALOG, PROVIDER_ERROR_CODES, PROVIDER_KINDS } from "../src/effects/provider-catalog";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";

interface LiteralViolation { readonly file: string; readonly line: number; readonly value: string }
const CATALOG_EXEMPTION = "provider-catalog.ts";
const definitions_root = resolve(import.meta.dir, "../../workflow-config/definitions");
const definition_names = ["development.json", "development-independent-siblings.json"] as const;
const definitions = await Promise.all(definition_names.map((name) => Bun.file(resolve(definitions_root, name)).json() as Promise<DefinitionBundle>));
const fact_keys = new Set(definitions.flatMap((bundle) => bundle.scopes.flatMap((scope) => [...scope.facts, ...scope.errors].map((fact) => fact.key))));
const restricted = new Set([
  ...Object.values(PROVIDER_KINDS), ...Object.values(INPUT_CONTRACTS), ...Object.values(PROVIDER_ERROR_CODES),
  ...PROVIDER_CATALOG.operations.map((operation) => operation.key), ...fact_keys,
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

test("provider, operation, fact and error literals live only in the named catalog module", async () => {
  const root = resolve(import.meta.dir, "../src/effects");
  const violations: LiteralViolation[] = [];
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
    if (file === CATALOG_EXEMPTION) continue;
    violations.push(...literalViolations(file, await Bun.file(resolve(root, file)).text()));
  }
  expect(violations).toEqual([]);
});

test("the lint detects each forbidden literal class and leaves ProviderRequest discriminants typed", async () => {
  const examples = [PROVIDER_KINDS.repository, PROVIDER_CATALOG.operations[0]!.key,
    [...fact_keys].find((key) => !Object.values(PROVIDER_ERROR_CODES).includes(key as never))!, PROVIDER_ERROR_CODES.head_changed];
  expect(examples.map((value) => literalViolations("other.ts", `const value = ${JSON.stringify(value)};`).length)).toEqual([1, 1, 1, 1]);
  const provider = await Bun.file(resolve(import.meta.dir, "../src/effects/provider.ts")).text();
  expect(literalViolations("provider.ts", provider)).toEqual([]);
});
