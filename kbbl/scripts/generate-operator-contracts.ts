/**
 * Generates kbbl/core/pwa/oakridge/operator-contracts/ from the operator API
 * the backend declares in oakridge-dbos/src/http/operator-api.ts.
 *
 * Every export of that module is a root. The TypeScript checker resolves each
 * type a root references, transitively, to its one declaration in the backend
 * (projections, storage rows, generated core contracts), and that declaration
 * is copied with every name prefixed `Operator`. Branded ids become `string`
 * and `Date` becomes `string`, which is what both serialize to. The PWA imports
 * no backend source, so its typecheck stays independent of oakridge-dbos.
 *
 * Each declaration lands in the file mirroring its backend module, so
 * projections/unit-view.ts generates operator-contracts/projections/unit-view.ts,
 * and generated files import one another as types only.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { selectDriftedFiles } from "./operator-contracts-drift";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "kbbl/core/pwa/oakridge/operator-contracts");
const backend = resolve(root, "oakridge-dbos/src");
const api = resolve(root, "oakridge-dbos/src/http/operator-api.ts");
const brands = resolve(root, "oakridge-dbos/src/domain/primitives.ts");
const PREFIX = "Operator";

type Declaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
interface Replacement { readonly start: number; readonly end: number; readonly text: string }
/** A declaration as generated, with the generated names it refers to. */
interface Rendered { readonly text: string; readonly references: ReadonlySet<string> }
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

/** Where a declaration is generated: the same path its backend module has under oakridge-dbos/src. */
function contractFile(declaration: Declaration): string {
  const path = relative(backend, resolve(declaration.getSourceFile().fileName));
  if (path.startsWith("..")) fail(`${declaration.name.text} is declared outside oakridge-dbos/src`);
  return path;
}

const names = new Map<string, ts.Symbol>();
const fileOfName = new Map<string, string>();
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
  if (!owner) { names.set(name, symbol); fileOfName.set(name, contractFile(declaration)); queue.push(symbol); }
  return { kind: "emit", name };
}

function replacementsIn(declaration: Declaration, references: Set<string>): Replacement[] {
  const replacements: Replacement[] = [{ start: declaration.name.getStart(), end: declaration.name.getEnd(), text: operatorName(declaration.name.text) }];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const resolution = resolveSymbol(checker.getSymbolAtLocation(node.typeName), node);
      if (resolution.kind === "string") { replacements.push({ start: node.getStart(), end: node.getEnd(), text: "string" }); return; }
      if (resolution.kind === "emit") {
        references.add(resolution.name);
        replacements.push({ start: node.typeName.getStart(), end: node.typeName.getEnd(), text: resolution.name });
      }
      node.typeArguments?.forEach(visit);
      return;
    }
    if (ts.isImportTypeNode(node)) {
      const type = checker.getTypeFromTypeNode(node);
      const symbol = type.aliasSymbol ?? type.getSymbol();
      const resolution = resolveSymbol(symbol, node);
      if (resolution.kind === "emit") references.add(resolution.name);
      const end = node.qualifier ? node.qualifier.getEnd() : node.getEnd();
      replacements.push({ start: node.getStart(), end, text: resolution.kind === "emit" ? resolution.name : resolution.kind === "string" ? "string" : symbol!.name });
      node.typeArguments?.forEach(visit);
      return;
    }
    if (ts.isExpressionWithTypeArguments(node)) {
      const resolution = resolveSymbol(checker.getSymbolAtLocation(node.expression), node);
      if (resolution.kind === "emit") {
        references.add(resolution.name);
        replacements.push({ start: node.expression.getStart(), end: node.expression.getEnd(), text: resolution.name });
      }
      node.typeArguments?.forEach(visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration, (child) => { if (child !== declaration.name) visit(child); });
  return replacements;
}

function render(declaration: Declaration): Rendered {
  const references = new Set<string>();
  const source = declaration.getSourceFile().text;
  const start = declaration.getStart();
  let text = source.slice(start, declaration.getEnd());
  for (const item of replacementsIn(declaration, references).sort((a, b) => b.start - a.start))
    text = text.slice(0, item.start - start) + item.text + text.slice(item.end - start);
  text = text.replace(/^(?:export\s+)?(?:declare\s+)?/, "export ");
  return { text: text.trimEnd().endsWith(";") || text.trimEnd().endsWith("}") ? text : `${text};`, references };
}

/** The type imports a generated file needs from the other generated files, in a stable order. */
function importsOf(file: string, blocks: readonly Rendered[]): string[] {
  const namesBySource = new Map<string, string[]>();
  for (const name of new Set(blocks.flatMap((block) => [...block.references]))) {
    const source = fileOfName.get(name) ?? fail(`${name} was referenced but never generated`);
    if (source !== file) namesBySource.set(source, [...(namesBySource.get(source) ?? []), name]);
  }
  return [...namesBySource].sort(([a], [b]) => a.localeCompare(b)).map(([source, imported]) => {
    const path = relative(dirname(file), source).replace(/\.ts$/, "");
    return `import type { ${imported.sort().join(", ")} } from "${path.startsWith(".") ? path : `./${path}`}";`;
  });
}

const module = checker.getSymbolAtLocation(program.getSourceFile(api)!);
if (!module) fail("operator-api.ts has no exports");
for (const exported of checker.getExportsOfModule(module)) resolveSymbol(exported, program.getSourceFile(api)!);
const contracts = new Map<string, Rendered[]>();
while (queue.length) {
  const declaration = declarationOf(queue.shift()!)!;
  const file = contractFile(declaration);
  contracts.set(file, [...(contracts.get(file) ?? []), render(declaration)]);
}

const HEADER = "// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.\n"
  + "// The PWA intentionally imports no backend source at runtime or typecheck time.\n\n";
const generated = new Map([...contracts].map(([file, blocks]) => {
  const imports = importsOf(file, blocks);
  return [file, HEADER + (imports.length ? `${imports.join("\n")}\n\n` : "") + blocks.map((block) => block.text).join("\n\n") + "\n"] as const;
}));

if (process.argv.includes("--check")) {
  const drifted = selectDriftedFiles(output, generated);
  if (drifted.length) throw new Error(`operator-contracts/ has drifted (${drifted.join(", ")}); run bun kbbl/scripts/generate-operator-contracts.ts`);
} else {
  rmSync(output, { recursive: true, force: true });
  for (const [file, text] of generated) {
    const path = resolve(output, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}
