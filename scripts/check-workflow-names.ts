import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import YAML from "yaml";
import { discoverWorkflowSources } from "../workflow-config/src/workflow-sources";
import { expandIncludes } from "../workflow-config/src/workflow-include";

type Mapping = Readonly<Record<string, unknown>>;
const mapping = (value: unknown): Mapping =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Mapping : {};

export function selectDeclaredNames(source: unknown): ReadonlySet<string> {
  const root = mapping(source);
  const names = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string") {
      for (const [, field] of value.matchAll(/(?:[,{])\s*([A-Za-z_][\w-]*)\s*:/g)) names.add(field);
      return;
    }
    for (const [key, child] of Object.entries(mapping(value))) {
      names.add(key);
      collect(child);
    }
  };
  const collectReview = (value: unknown) => {
    const review = mapping(value);
    const decisions = mapping(review.decisions);
    for (const name of Object.keys(decisions)) if (typeof decisions[name] === "object") names.add(name);
    for (const name of Object.values(mapping(decisions.rename))) if (typeof name === "string") names.add(name);
    for (const declaration of Object.values(decisions)) collect(mapping(declaration).payload);
  };
  for (const set of Object.values(mapping(root.decisions))) {
    Object.keys(mapping(set)).forEach((key) => names.add(key));
    for (const decision of Object.values(mapping(set))) collect(mapping(decision).payload);
  }
  collect(root.schemas);
  collect(root.input);
  for (const [key, stage] of Object.entries(mapping(root.stages))) {
    names.add(key);
    const declaration = mapping(stage);
    for (const name of Object.keys(mapping(declaration.workers))) names.add(name);
    for (const [name, artifact] of Object.entries(mapping(declaration.artifacts))) {
      names.add(name);
      collect(mapping(artifact).schema);
    }
    for (const [name, review] of Object.entries(mapping(declaration.reviews))) {
      names.add(name);
      collectReview(review);
    }
    collect(declaration.input);
    for (const key of Object.keys(mapping(declaration.outcome))) names.add(key);
  }
  for (const name of Object.keys(mapping(root.workers))) names.add(name);
  for (const [name, review] of Object.entries(mapping(root.reviews))) {
    names.add(name);
    collectReview(review);
  }
  return names;
}

const sourceFile = (path: string, source: string): ts.SourceFile =>
  ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function propertyName(node: ts.Node, includeDeclarations = false): boolean {
  const parent = node.parent;
  return Boolean(parent && "name" in parent && parent.name === node && (
    ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isPropertyAccessExpression(parent)
      || includeDeclarations && (ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent))));
}

function contractVocabulary(path: string): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || (ts.isStringLiteral(node) && propertyName(node, true))) names.add(node.text);
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) names.add(node.typeName.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile(path, readFileSync(path, "utf8")), visit);
  return names;
}

function isRegistryKey(node: ts.Node): boolean {
  if (!ts.isPropertyAssignment(node.parent)) return false;
  const expression = node.parent.parent;
  if (!ts.isObjectLiteralExpression(expression)) return false;
  if (expression.parent && ts.isArrayLiteralExpression(expression.parent)) {
    if (!ts.isStringLiteralLike(node) || !ts.isIdentifier(node.parent.name) || node.parent.name.text !== "key") return false;
    let owner = expression.parent.parent;
    while (ts.isAsExpression(owner) || ts.isSatisfiesExpression(owner)) owner = owner.parent;
    return ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name) && owner.name.text === "OPERATION_REGISTRY";
  }
  if (node.parent.name !== node) return false;
  let owner = expression.parent;
  while (ts.isAsExpression(owner) || ts.isSatisfiesExpression(owner)) owner = owner.parent;
  return ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)
    && (owner.name.text === "VIEWERS" || owner.name.text === "OPERATION_KEYS");
}

export function checkWorkflowNameFile(path: string, source: string, names: ReadonlySet<string>): readonly string[] {
  const file = sourceFile(path, source);
  const findings: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || (ts.isIdentifier(node) && propertyName(node))) && names.has(node.text) && !isRegistryKey(node)) {
      const position = file.getLineAndCharacterOfPosition(node.getStart(file));
      findings.push(`${path}:${position.line + 1} ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return findings;
}

const roots = ["oakridge-dbos/src", "kbbl/core", "observation/src/producers"];
const generatedDir = new Set(["operator-contracts", "grading-contracts", "__fixtures__", "__tests__", "node_modules"]);
function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return generatedDir.has(entry.name) ? [] : filesUnder(child);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.(test|spec|generated)\.tsx?$/.test(entry.name)) return [];
    return [child];
  });
}

export function checkWorkflowNames(root: string): readonly string[] {
  const paths = ["core-types.ts", "source-types.ts"].map((path) => resolve(root, "oakridge-dbos/src/core-client", path));
  const language = new Set(paths.flatMap((path) => [...contractVocabulary(path)]));
  const workflows = ["development", "study"];
  const names = new Set(workflows.flatMap((workflow) => {
    const file = resolve(root, "workflow-config", `${workflow}.yaml`);
    const document = YAML.parseDocument(readFileSync(file, "utf8"));
    const expanded = expandIncludes(document, (path) => YAML.parseDocument(readFileSync(resolve(root, "workflow-config", path), "utf8")));
    if (!expanded.ok) throw new Error(expanded.error.detail);
    return [...selectDeclaredNames(expanded.value.toJS())].filter((name) => !language.has(name));
  }));
  const extractors = new Set(discoverWorkflowSources(root).map(({ name }) => `observation/src/producers/oakridge/extractors/${name}.ts`));
  return roots.flatMap((directory) => filesUnder(resolve(root, directory))).sort().flatMap((path) => {
    const name = relative(root, path);
    if (paths.includes(path) || extractors.has(name) || name === "observation/src/producers/oakridge/artifact-versions.ts") return [];
    return checkWorkflowNameFile(name, readFileSync(path, "utf8"), names);
  });
}

if (import.meta.main) {
  const findings = checkWorkflowNames(resolve(import.meta.dir, ".."));
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  }
}
