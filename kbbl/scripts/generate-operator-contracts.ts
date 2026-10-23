/**
 * Generates kbbl/core/pwa/oakridge/operator-contracts.ts from the operator API
 * the backend declares in oakridge-dbos/src/http/operator-api.ts.
 *
 * Every export of that module is a root. The TypeScript checker resolves each
 * type a root references, transitively, to its one declaration in the backend
 * (projections, storage rows, generated core contracts), and that declaration
 * is copied with every name prefixed `Operator`. Branded ids become `string`
 * and `Date` becomes `string`, which is what both serialize to. The PWA imports
 * no backend source, so its typecheck stays independent of oakridge-dbos.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "kbbl/core/pwa/oakridge/operator-contracts.ts");
const api = resolve(root, "oakridge-dbos/src/http/operator-api.ts");
const brands = resolve(root, "oakridge-dbos/src/domain/primitives.ts");
const PREFIX = "Operator";

type Declaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
interface Replacement { readonly start: number; readonly end: number; readonly text: string }
/** How a referenced symbol appears in the generated file. */
type Resolution =
  | { readonly kind: "keep" }
  | { readonly kind: "string" }
  | { readonly kind: "emit"; readonly name: string };

const program = ts.createProgram([api], { strict: true, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, noEmit: true, types: [] });
const checker = program.getTypeChecker();

function fail(detail: string): never { throw new Error(`generate-operator-contracts: ${detail}`); }
const pascal = (name: string): string => name.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
const operatorName = (name: string): string => name.startsWith(PREFIX) ? name : `${PREFIX}${pascal(name)}`;
function target(symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}
function declarationOf(symbol: ts.Symbol): Declaration | null {
  const declarations = symbol.declarations ?? [];
  const found = declarations.filter((item): item is Declaration => ts.isInterfaceDeclaration(item) || ts.isTypeAliasDeclaration(item));
  if (found.length > 1) fail(`${symbol.name} has ${found.length} declarations; merge them before exporting`);
  return found[0] ?? null;
}
const isLibrary = (node: ts.Node): boolean => {
  const file = node.getSourceFile();
  return program.isSourceFileDefaultLibrary(file) || file.fileName.includes(`${sep}node_modules${sep}`);
};
/** `type RunId = Brand<string, "RunId">` in domain/primitives.ts serializes as a string. */
function isBrand(declaration: Declaration): boolean {
  return resolve(declaration.getSourceFile().fileName) === brands && ts.isTypeAliasDeclaration(declaration)
    && ts.isTypeReferenceNode(declaration.type) && declaration.type.typeName.getText() === "Brand";
}

const emitted = new Map<ts.Symbol, string>();
const names = new Map<string, ts.Symbol>();
const queue: ts.Symbol[] = [];
function resolveSymbol(raw: ts.Symbol | undefined, location: ts.Node): Resolution {
  if (!raw) fail(`unresolved type reference ${location.getText()} in ${location.getSourceFile().fileName}`);
  const symbol = target(raw);
  if (symbol.flags & ts.SymbolFlags.TypeParameter) return { kind: "keep" };
  if (symbol.name === "Date" && (symbol.declarations ?? []).every(isLibrary)) return { kind: "string" };
  const declaration = declarationOf(symbol);
  if (!declaration) {
    if ((symbol.declarations ?? []).every(isLibrary)) return { kind: "keep" };
    fail(`${symbol.name} is not an interface or type alias; the operator API must expose only types`);
  }
  if (isLibrary(declaration)) return { kind: "keep" };
  if (isBrand(declaration)) return { kind: "string" };
  const name = operatorName(symbol.name);
  const owner = names.get(name);
  if (owner && owner !== symbol) fail(`two backend types both generate ${name}; rename one`);
  if (!owner) { names.set(name, symbol); queue.push(symbol); }
  return { kind: "emit", name };
}

function replacementsIn(declaration: Declaration): Replacement[] {
  const replacements: Replacement[] = [{ start: declaration.name.getStart(), end: declaration.name.getEnd(), text: operatorName(declaration.name.text) }];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const resolution = resolveSymbol(checker.getSymbolAtLocation(node.typeName), node);
      if (resolution.kind === "string") { replacements.push({ start: node.getStart(), end: node.getEnd(), text: "string" }); return; }
      if (resolution.kind === "emit") replacements.push({ start: node.typeName.getStart(), end: node.typeName.getEnd(), text: resolution.name });
      node.typeArguments?.forEach(visit);
      return;
    }
    if (ts.isImportTypeNode(node)) {
      const type = checker.getTypeFromTypeNode(node);
      const symbol = type.aliasSymbol ?? type.getSymbol();
      const resolution = resolveSymbol(symbol, node);
      const end = node.qualifier ? node.qualifier.getEnd() : node.getEnd();
      replacements.push({ start: node.getStart(), end, text: resolution.kind === "emit" ? resolution.name : resolution.kind === "string" ? "string" : symbol!.name });
      node.typeArguments?.forEach(visit);
      return;
    }
    if (ts.isExpressionWithTypeArguments(node)) {
      const resolution = resolveSymbol(checker.getSymbolAtLocation(node.expression), node);
      if (resolution.kind === "emit") replacements.push({ start: node.expression.getStart(), end: node.expression.getEnd(), text: resolution.name });
      node.typeArguments?.forEach(visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration, (child) => { if (child !== declaration.name) visit(child); });
  return replacements;
}

function render(declaration: Declaration): string {
  const source = declaration.getSourceFile().text;
  const start = declaration.getStart();
  let text = source.slice(start, declaration.getEnd());
  for (const item of replacementsIn(declaration).sort((a, b) => b.start - a.start))
    text = text.slice(0, item.start - start) + item.text + text.slice(item.end - start);
  text = text.replace(/^(?:export\s+)?(?:declare\s+)?/, "export ");
  return text.trimEnd().endsWith(";") || text.trimEnd().endsWith("}") ? text : `${text};`;
}

const module = checker.getSymbolAtLocation(program.getSourceFile(api)!);
if (!module) fail("operator-api.ts has no exports");
for (const exported of checker.getExportsOfModule(module)) resolveSymbol(exported, program.getSourceFile(api)!);
const blocks: string[] = [];
while (queue.length) {
  const symbol = queue.shift()!;
  if (emitted.has(symbol)) continue;
  const declaration = declarationOf(symbol)!;
  const block = render(declaration);
  emitted.set(symbol, block);
  blocks.push(block);
}

const generated = "// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.\n"
  + "// The PWA intentionally imports no backend source at runtime or typecheck time.\n\n"
  + blocks.join("\n\n") + "\n";

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated) throw new Error("operator-contracts.ts has drifted; run bun kbbl/scripts/generate-operator-contracts.ts");
} else writeFileSync(output, generated);
