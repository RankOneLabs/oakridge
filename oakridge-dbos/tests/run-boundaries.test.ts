import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import type { Group, Workflow } from "../src/core-client/core-types";
import { productionTokens, rustLibraryGraph } from "./rust-boundary";
import { sampleWorkflow } from "./authority-fixture";

const root = resolve(import.meta.dir, "../..");
const src = resolve(root, "oakridge-dbos/src");
const sources = (directory: string, skip: RegExp = /$^/): readonly string[] =>
  [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: directory })].filter((file) => !skip.test(file)).map((file) => resolve(directory, file));
const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);

// ------------------------------------------------------------------ K2 -----
// Run code imports only the core's compile/step API and generated types (part 1 §11).

/** What run code may import, as values, from the core client: the client itself, compile, the wanted-action reader, and where the WASM is. */
const CORE_CLIENT_VALUES = new Set(["CoreClient", "compileWorkflow", "selectWanted", "CORE_WASM_PATH"]);
const GENERATED_CORE_CONSTANTS = new Set(["ROOT_DECLARATION", "VALIDATION_REVIEW"]);
interface CoreImport { readonly file: string; readonly module: string; readonly name: string; readonly is_type: boolean }
function coreImports(file: string): readonly CoreImport[] {
  const imports: CoreImport[] = [];
  for (const statement of parse(file).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (!module.includes("core-client/") && !module.includes("workflow-core")) continue;
    const clause = statement.importClause;
    const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
    const is_type = clause?.isTypeOnly ?? false;
    if (clause?.name) imports.push({ file, module, name: "default", is_type });
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) imports.push({ file, module, name: "*", is_type });
    for (const element of named) imports.push({ file, module, name: (element.propertyName ?? element.name).text, is_type: is_type || element.isTypeOnly });
    if (!clause) imports.push({ file, module, name: "side effect", is_type: false });
  }
  return imports;
}
function k2Violations(imports: readonly CoreImport[]): readonly string[] {
  return imports.flatMap((entry) => {
    const where = `${relative(root, entry.file)}: ${entry.name} from ${entry.module}`;
    if (entry.module.includes("workflow-core")) return [`${where} (reaches into the core's sources)`];
    if (entry.is_type) return [];
    if (entry.module.endsWith("core-client/client") && CORE_CLIENT_VALUES.has(entry.name)) return [];
    if (entry.module.endsWith("core-client/core-types") && GENERATED_CORE_CONSTANTS.has(entry.name)) return [];
    return [`${where} (a value outside the compile/step API)`];
  });
}

test("K2: run code imports only the core's compile/step API and generated types", () => {
  const imports = sources(src, /^core-client\//).flatMap(coreImports);
  expect(imports.length).toBeGreaterThan(10);
  expect(k2Violations(imports)).toEqual([]);
});

test("K2: a value import from the generated types, or a reach into the core's sources, fails the check", () => {
  expect(k2Violations([
    { file: resolve(src, "x.ts"), module: "../core-client/core-types", name: "decodeCoreResponse", is_type: false },
    { file: resolve(src, "x.ts"), module: "../../workflow-core/fixtures/bundles/fan-out.json", name: "default", is_type: false },
    { file: resolve(src, "x.ts"), module: "../core-client/client", name: "compileWorkflow", is_type: false },
  ]).length).toBe(2);
});

// ------------------------------------------------------------------ K3 -----
// Adding sample A or B touches only workflow-config/ (part 1 §11): no
// production source names a sample. Most of a sample's keys are ordinary
// words ("worker", "result"), so the names checked are the ones only a sample
// gives: its workflow key, its prompt paths and the keys no other code uses.
// executor-e2e.test.ts carries the converse: a renamed copy of sample A runs.

function promptPaths(workflow: Workflow): readonly string[] {
  return Object.values(workflow.stages).flatMap((stage) => [
    ...Object.values(stage.workers).flatMap((worker) => worker.kind === "agent" ? Object.values(worker.prompts).filter((path): path is string => path != null) : []),
    ...Object.values(stage.reviews ?? {}).flatMap((review) => review.prompt ? [review.prompt] : []),
  ]);
}
const unitKeys = (group: Group): readonly string[] =>
  Object.entries(group.units).flatMap(([key, unit]) => [key, ...(unit.group ? unitKeys(unit.group) : [])]);
/** Keys a sample introduces that are not also words the run layer or the PWA uses for their own meaning. */
const DISTINCTIVE_KEYS = ["critique", "critic", "editor"];
function sampleNames(name: "review-loop" | "fan-out"): readonly string[] {
  const workflow = sampleWorkflow(name);
  const declared = new Set([workflow.workflow, ...Object.keys(workflow.stages), ...unitKeys(workflow.run),
    ...Object.values(workflow.stages).flatMap((stage) => [...Object.keys(stage.artifacts), ...Object.keys(stage.workers), ...Object.keys(stage.reviews ?? {})])]);
  return [workflow.workflow, `${name}/`, ...promptPaths(workflow), ...DISTINCTIVE_KEYS.filter((key) => declared.has(key))];
}
function namedIn(names: readonly string[], text: string): readonly string[] {
  return names.filter((name) => name.endsWith("/") || name.includes(".") ? text.includes(name) : text === name);
}

test("K3: no production source names sample A or B", () => {
  const names = [...sampleNames("review-loop"), ...sampleNames("fan-out")];
  const typescript = [...sources(src), ...sources(resolve(root, "kbbl/core"), /\.test\.tsx?$|__fixtures__|test-harness/)].flatMap((file) => {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(...namedIn(names, node.text).map((name) => `${relative(root, file)}: ${name}`));
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
    return found;
  });
  const rust = rustLibraryGraph(root).flatMap((file) => productionTokens(readFileSync(file, "utf8"))
    .filter((token) => token.kind === "string").flatMap((token) => namedIn(names, token.text).map((name) => `${relative(root, file)}: ${name}`)));
  expect({ names: names.length > 10, typescript, rust }).toEqual({ names: true, typescript: [], rust: [] });
});

test("K3: a sample's name in a production literal fails the check", () => {
  expect(namedIn(sampleNames("review-loop"), "review-loop/write.md")).toEqual(["review-loop/", "review-loop/write.md"]);
});
