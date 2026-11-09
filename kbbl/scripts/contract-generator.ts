/**
 * Generates a PWA contract directory from the API module a backend declares.
 *
 * Every export of the API module is a root. The TypeScript checker resolves each
 * type a root references, transitively, to its one declaration in the backend,
 * and that declaration is copied with every name prefixed. `Date` becomes
 * `string`, which is what it serializes to. Branded ids either become `string`
 * too (`erase`) or are copied like any other declaration with their brand
 * (`keep`). The PWA imports no backend source, so its typecheck stays
 * independent of the backend.
 *
 * Each declaration lands in the file mirroring its backend module under its
 * source root, and generated files import one another as types only.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { selectDriftedFiles } from "./operator-contracts-drift";

/** How branded ids reach the PWA: as the strings they serialize to, or with their brands. */
export type BrandMode =
  | { readonly kind: "erase"; readonly primitives: string }
  | { readonly kind: "keep" };
export interface ContractConfig {
  /** Names this generator in errors: the script under kbbl/scripts that runs it. */
  readonly name: string;
  /** The repository root, which paths in messages are relative to. */
  readonly root: string;
  /** The module whose every export is a root. */
  readonly api: string;
  /** The one directory every generated declaration must be declared under; paths mirror it. */
  readonly backend: string;
  readonly output: string;
  readonly prefix: string;
  readonly brands: BrandMode;
  readonly header: string;
}

type Declaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
interface Replacement { readonly start: number; readonly end: number; readonly text: string }
/** A declaration as generated, with the generated names it refers to. */
interface Rendered { readonly text: string; readonly references: ReadonlySet<string> }
/** How a referenced symbol appears in the generated file. */
type Resolution =
  | { readonly kind: "keep" }
  | { readonly kind: "string" }
  | { readonly kind: "emit"; readonly name: string };

/** The generated files, by path relative to the output directory. */
export function generateContracts(config: ContractConfig): ReadonlyMap<string, string> {
  const program = ts.createProgram([config.api], { strict: true, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, noEmit: true, types: [] });
  const checker = program.getTypeChecker();

  const fail = (detail: string): never => { throw new Error(`${config.name}: ${detail}`); };
  const pascal = (name: string): string => name.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  const prefixedName = (name: string): string => name.startsWith(config.prefix) ? name : `${config.prefix}${pascal(name)}`;
  const target = (symbol: ts.Symbol): ts.Symbol => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
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
  /** In erase mode, `type RunId = Brand<string, "RunId">` in the primitives module serializes as a string. */
  function isErasedBrand(declaration: Declaration): boolean {
    if (config.brands.kind !== "erase") return false;
    return resolve(declaration.getSourceFile().fileName) === config.brands.primitives && ts.isTypeAliasDeclaration(declaration)
      && ts.isTypeReferenceNode(declaration.type) && declaration.type.typeName.getText() === "Brand";
  }

  /** Where a declaration is generated: the same path its backend module has under the backend root. */
  function contractFile(declaration: Declaration): string {
    const path = relative(config.backend, resolve(declaration.getSourceFile().fileName));
    if (path.startsWith("..")) fail(`${declaration.name.text} is declared outside ${relative(config.root, config.backend)}`);
    return path;
  }

  const names = new Map<string, ts.Symbol>();
  const fileOfName = new Map<string, string>();
  const queue: ts.Symbol[] = [];
  function resolveSymbol(raw: ts.Symbol | undefined, location: ts.Node): Resolution {
    if (!raw) fail(`unresolved type reference ${location.getText()} in ${location.getSourceFile().fileName}`);
    const symbol = target(raw as ts.Symbol);
    if (symbol.flags & ts.SymbolFlags.TypeParameter) return { kind: "keep" };
    if (symbol.name === "Date" && (symbol.declarations ?? []).every(isLibrary)) return { kind: "string" };
    const declaration = declarationOf(symbol);
    if (!declaration) {
      if ((symbol.declarations ?? []).every(isLibrary)) return { kind: "keep" };
      fail(`${symbol.name} is not an interface or type alias; the API must expose only types`);
    }
    const found = declaration as Declaration;
    if (isLibrary(found)) return { kind: "keep" };
    if (isErasedBrand(found)) return { kind: "string" };
    const name = prefixedName(symbol.name);
    const owner = names.get(name);
    if (owner && owner !== symbol) fail(`two backend types both generate ${name}; rename one`);
    if (!owner) { names.set(name, symbol); fileOfName.set(name, contractFile(found)); queue.push(symbol); }
    return { kind: "emit", name };
  }

  function replacementsIn(declaration: Declaration, references: Set<string>): Replacement[] {
    const replacements: Replacement[] = [{ start: declaration.name.getStart(), end: declaration.name.getEnd(), text: prefixedName(declaration.name.text) }];
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
      if (ts.isTypeQueryNode(node)) fail(`${declaration.name.text} uses a value's type (${node.getText()}); name the type instead`);
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

  const apiFile = program.getSourceFile(config.api) ?? fail(`${config.api} was not found`);
  const module = checker.getSymbolAtLocation(apiFile) ?? fail(`${relative(config.backend, config.api)} has no exports`);
  for (const exported of checker.getExportsOfModule(module)) resolveSymbol(exported, apiFile);
  const contracts = new Map<string, Rendered[]>();
  while (queue.length) {
    const declaration = declarationOf(queue.shift()!)!;
    const file = contractFile(declaration);
    contracts.set(file, [...(contracts.get(file) ?? []), render(declaration)]);
  }
  return new Map([...contracts].map(([file, blocks]) => {
    const imports = importsOf(file, blocks);
    return [file, config.header + (imports.length ? `${imports.join("\n")}\n\n` : "") + blocks.map((block) => block.text).join("\n\n") + "\n"] as const;
  }));
}

/** `--check` fails on any drift without writing; otherwise the output directory is replaced. */
export function writeContracts(config: ContractConfig, argv: readonly string[]): void {
  const generated = generateContracts(config);
  if (argv.includes("--check")) {
    const drifted = selectDriftedFiles(config.output, generated);
    if (drifted.length) throw new Error(`${relative(config.root, config.output)}/ has drifted (${drifted.join(", ")}); run bun kbbl/scripts/${config.name}.ts`);
    return;
  }
  rmSync(config.output, { recursive: true, force: true });
  for (const [file, text] of generated) {
    const path = resolve(config.output, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}
