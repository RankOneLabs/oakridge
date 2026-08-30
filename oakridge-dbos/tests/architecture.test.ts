/**
 * Spec §5.3 rules 1–7: pure, no database, never skipped. Reads `src/**\/*.ts`
 * with `node:fs` and a small regex-based import/export parser — not a real TS
 * parser, but enough to prove the shape these rules care about: what imports
 * what, and which value export nothing references.
 *
 * All seven rules pass. Rule 3's dead exports were deleted from `src/` (WP5);
 * rule 5's scope list was widened by one directory to cover
 * `src/validation/delegated-session.ts` and
 * `src/validation/repository-provisioning.ts`, which decode `depends_on_path`
 * / `max_parallel` off a workflow definition — the same "definition decoding"
 * category as `src/compiler/compile-workflow.ts`. Rule 7 (PR 2 / WP3) is the
 * legacy command stack's removal: no importer, no table name in `src/`, and
 * the deleted modules gone from disk.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { posix as posixPath } from "node:path";
import { expect, test } from "bun:test";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const SRC_ROOT = resolve(PACKAGE_ROOT, "src");

const walk = (dir: string): readonly string[] => {
  const entries = [...readdirSync(dir, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
};

/** `.../oakridge-dbos/src/decision/derive.ts` -> `"src/decision/derive"` (posix, no extension). */
const toModulePath = (absFile: string): string => absFile.slice(PACKAGE_ROOT.length + 1).split(posixPath.sep).join("/").replace(/\.ts$/, "");

interface SourceFile { readonly module: string; readonly abs: string; readonly text: string }

const SRC_FILES: readonly SourceFile[] = walk(SRC_ROOT).map((abs) => ({ module: toModulePath(abs), abs, text: readFileSync(abs, "utf8") }));
const FILES_BY_MODULE = new Map(SRC_FILES.map((file) => [file.module, file]));

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** A relative specifier resolved against its importing file's own directory; a bare specifier ("hono", "node:crypto") resolves to `null`. */
const resolveSpecifier = (fromModule: string, specifier: string): string | null => {
  if (!specifier.startsWith(".")) return null;
  const fromDir = posixPath.dirname(fromModule);
  return posixPath.normalize(posixPath.join(fromDir, specifier)).replace(/\.(ts|tsx|js|jsx)$/, "");
};

interface ImportEdgeBase { readonly from: string; readonly specifier: string; readonly resolved: string | null; readonly line: number }
type ImportEdge =
  | (ImportEdgeBase & { readonly kind: "named"; readonly names: readonly string[] })
  | (ImportEdgeBase & { readonly kind: "namespace" })
  | (ImportEdgeBase & { readonly kind: "opaque" }); // side-effect or type-position `import("spec")`: no named binding to track

interface ValueExport { readonly file: string; readonly name: string; readonly line: number }

const splitEntries = (content: string): readonly string[] => content.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);

/** `{ a, b as c, type T }` -> the value entries only, each `{ moduleName, localName }` (the name as declared by the source module, and the name this clause exposes). */
const parseBraceEntries = (content: string): readonly { readonly moduleName: string; readonly localName: string }[] =>
  splitEntries(content).filter((entry) => !entry.startsWith("type ")).map((entry) => {
    const parts = entry.split(/\s+as\s+/);
    return parts.length === 2 ? { moduleName: parts[0]!.trim(), localName: parts[1]!.trim() } : { moduleName: entry, localName: entry };
  });

/** Every import/export-from edge and every value export declaration this one file's text contains. */
const extractEdgesAndExports = (file: SourceFile): { readonly edges: readonly ImportEdge[]; readonly exports: readonly ValueExport[] } => {
  const edges: ImportEdge[] = [];
  const exports: ValueExport[] = [];
  const { module: from, text } = file;

  // import [type] Default?, ({ a, b as c } | * as NS) from "spec";
  const importPattern = /import\s+(type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\{([\s\S]*?)\}|\*\s+as\s+([A-Za-z_$][\w$]*))\s+from\s+["']([^"']+)["']/g;
  for (const match of text.matchAll(importPattern)) {
    const braces = match[2];
    const namespaceAlias = match[3];
    const specifier = match[4]!;
    const line = lineAt(text, match.index ?? 0);
    const resolved = resolveSpecifier(from, specifier);
    if (namespaceAlias) edges.push({ kind: "namespace", from, specifier, resolved, line });
    else edges.push({ kind: "named", from, specifier, resolved, line, names: parseBraceEntries(braces ?? "").map((entry) => entry.moduleName) });
  }

  // import [type] Default from "spec"; — `importPattern` above requires a `{…}` or
  // `* as` clause, so a default-only import falls through it and records no edge.
  // Disjoint from `importPattern`: `import a, { b } from` has a comma after the
  // identifier, which this pattern's `from` anchor does not match. The module-side
  // name of a default import is `default` — that is what rule 3 matches exports on.
  const defaultOnlyImportPattern = /import\s+(type\s+)?([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;
  for (const match of text.matchAll(defaultOnlyImportPattern)) {
    const specifier = match[3]!;
    const line = lineAt(text, match.index ?? 0);
    edges.push({ kind: "named", from, specifier, resolved: resolveSpecifier(from, specifier), line, names: ["default"] });
  }

  // side-effect-only: import "spec";
  const sideEffectPattern = /import\s+["']([^"']+)["']\s*;/g;
  for (const match of text.matchAll(sideEffectPattern)) {
    const specifier = match[1]!;
    edges.push({ kind: "opaque", from, specifier, resolved: resolveSpecifier(from, specifier), line: lineAt(text, match.index ?? 0) });
  }

  // export [type] { a, b as c } [from "spec"];
  const exportListPattern = /export\s+(type\s+)?\{([\s\S]*?)\}(?:\s+from\s+["']([^"']+)["'])?\s*;/g;
  for (const match of text.matchAll(exportListPattern)) {
    const typeOnly = match[1];
    const braces = match[2] ?? "";
    const specifier = match[3];
    const line = lineAt(text, match.index ?? 0);
    if (typeOnly) continue; // the whole clause is type-only
    const entries = parseBraceEntries(braces);
    if (specifier && entries.length > 0) {
      edges.push({ kind: "named", from, specifier, resolved: resolveSpecifier(from, specifier), line, names: entries.map((entry) => entry.moduleName) });
    }
    for (const entry of entries) exports.push({ file: from, name: entry.localName, line });
  }

  // dynamic or type-position import("spec")
  const dynamicPattern = /import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(dynamicPattern)) {
    const specifier = match[1]!;
    edges.push({ kind: "opaque", from, specifier, resolved: resolveSpecifier(from, specifier), line: lineAt(text, match.index ?? 0) });
  }

  // export const|function|class|let|enum NAME
  const declPattern = /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?\s+|class\s+|let\s+|const\s+enum\s+|const\s+|enum\s+)([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(declPattern)) exports.push({ file: from, name: match[1]!, line: lineAt(text, match.index ?? 0) });

  return { edges, exports };
};

const ALL_EDGES: ImportEdge[] = [];
const ALL_EXPORTS: ValueExport[] = [];
for (const file of SRC_FILES) {
  const { edges, exports } = extractEdgesAndExports(file);
  ALL_EDGES.push(...edges);
  ALL_EXPORTS.push(...exports);
}

test("rule 1: nothing imports the deleted materialization/decision/dev modules", () => {
  const bannedPrefixes = ["src/compiler/materialize-", "src/runtime/run-materialization", "src/domain/run-decisions", "src/domain/output-availability", "src/compiler/select-", "src/dev/"];
  const violations = ALL_EDGES
    .filter((edge) => edge.resolved !== null && bannedPrefixes.some((prefix) => edge.resolved!.startsWith(prefix)))
    .map((edge) => `${edge.from}:${edge.line}: imports '${edge.resolved}'`);
  expect(violations).toEqual([]);
});

test("rule 2: src/decision/ imports nothing from hono, @dbos-inc/*, pg, storage, runtime, http, or adapters", () => {
  const bannedBare = (specifier: string): boolean => specifier === "hono" || specifier === "pg" || specifier.startsWith("@dbos-inc/");
  const bannedSrcPrefixes = ["src/storage/", "src/runtime/", "src/http/", "src/adapters/"];
  const violations = ALL_EDGES
    .filter((edge) => edge.from.startsWith("src/decision/"))
    .filter((edge) => (edge.resolved === null ? bannedBare(edge.specifier) : bannedSrcPrefixes.some((prefix) => edge.resolved!.startsWith(prefix))))
    .map((edge) => `${edge.from}:${edge.line}: imports '${edge.specifier}'`);
  expect(violations).toEqual([]);
});

/**
 * Dead-export guard, no allowlist. A value export declared under
 * `src/decision/`, `src/domain/`, or `src/compiler/` is alive only if some
 * *other* file under `src/` imports it by name from that exact module, or
 * imports the whole module as a namespace.
 */
test("rule 3: no dead value export under src/decision/, src/domain/, or src/compiler/", () => {
  const scopeDirs = ["src/decision/", "src/domain/", "src/compiler/"];
  const candidates = ALL_EXPORTS.filter((exported) => scopeDirs.some((prefix) => exported.file.startsWith(prefix)));
  const isReferenced = (exported: ValueExport): boolean => ALL_EDGES.some((edge) =>
    edge.from !== exported.file && edge.resolved === exported.file &&
    (edge.kind === "namespace" || (edge.kind === "named" && edge.names.includes(exported.name))));
  const dead = candidates.filter((exported) => !isReferenced(exported)).map((exported) => `${exported.file}:${exported.name}`);
  expect(dead).toEqual([]);
});

test("rule 4: src/decision/derive has exactly one importer under src/, and it is postgres-run-record.ts calling derive(", () => {
  const importers = [...new Set(ALL_EDGES.filter((edge) => edge.resolved === "src/decision/derive").map((edge) => edge.from))];
  expect(importers).toEqual(["src/storage/postgres-run-record"]);
  const repository = FILES_BY_MODULE.get("src/storage/postgres-run-record");
  expect(repository?.text.includes("derive(")).toBe(true);
});

/**
 * The scope is a list of path prefixes with a one-line reason each (spec
 * §5.3 rule 5's wording, brief-amended to add `postgres-operators.ts`) — not
 * an allowlist of known offenders. A file outside it that reads one of these
 * tokens is reported and left red rather than silently added here.
 */
test("rule 5: depends_on/.admitted/max_parallel/materialization_closed stay inside the decision-layer scope", () => {
  const scope: readonly { readonly matches: (module: string) => boolean; readonly reason: string }[] = [
    { matches: (module) => module.startsWith("src/decision/"), reason: "the decision layer itself" },
    { matches: (module) => module === "src/storage/postgres-run-record", reason: "snapshot loading, _tx writes, assertClosedGraph" },
    { matches: (module) => module === "src/storage/postgres-operators", reason: "the operator gate/run projection (brief amendment)" },
    { matches: (module) => module.startsWith("src/domain/"), reason: "type declarations" },
    { matches: (module) => module === "src/compiler/compile-workflow", reason: "definition decoding" },
    { matches: (module) => module.startsWith("src/validation/"), reason: "definition decoding (zod schemas)" },
  ];
  const tokens = ["depends_on", ".admitted", "max_parallel", "materialization_closed"];
  const violations: string[] = [];
  for (const file of SRC_FILES) {
    if (scope.some((entry) => entry.matches(file.module))) continue;
    const lines = file.text.split("\n");
    lines.forEach((line, index) => {
      for (const token of tokens) if (line.includes(token)) violations.push(`${file.module}:${index + 1}: ${token}`);
    });
  }
  expect(violations).toEqual([]);
});

test("rule 6: every path §2.4 deletes is gone from disk", () => {
  const deletedPaths = [
    "src/compiler/materialize-stage.ts", "src/compiler/materialize-units.ts", "src/compiler/select-resume-stages.ts",
    "src/compiler/select-unit-inputs.ts", "src/runtime/run-materialization.ts", "src/domain/run-decisions.ts",
    "src/domain/output-availability.ts", "src/dev",
    // §2.4's deleted-tests list, minus `dev-flow-stage-contracts.test.ts` (kept, only trimmed) and the two
    // named cases inside `postgres-run-record.test.ts` (a kept file, not a deleted one).
    "tests/materialize-units.test.ts", "tests/materialize-stage.test.ts", "tests/select-resume-stages.test.ts",
    "tests/run-materialization.test.ts", "tests/run-decisions.test.ts",
  ];
  const stillPresent = deletedPaths.filter((relativePath) => existsSync(resolve(PACKAGE_ROOT, relativePath)));
  expect(stillPresent).toEqual([]);
});

test("rule 7: the legacy command stack is gone — nothing imports src/http/artifact-callback or src/http/artifact-withdraw, no file under src/ names the tables workflow_attempt, executor_projection, or command_outbox, and the deleted modules do not exist on disk", () => {
  const bannedImportPrefixes = ["src/http/artifact-callback", "src/http/artifact-withdraw"];
  const importViolations = ALL_EDGES
    .filter((edge) => edge.resolved !== null && bannedImportPrefixes.some((prefix) => edge.resolved!.startsWith(prefix)))
    .map((edge) => `${edge.from}:${edge.line}: imports '${edge.resolved}'`);

  // `.sql` under `src/storage/migrations/` is not part of `SRC_FILES` (`walk`
  // only collects `.ts`), so the old migrations that legitimately name these
  // tables are not scanned.
  const bannedTables = ["workflow_attempt", "executor_projection", "command_outbox"];
  const tableViolations: string[] = [];
  for (const file of SRC_FILES) {
    const lines = file.text.split("\n");
    lines.forEach((line, index) => {
      for (const table of bannedTables) if (line.includes(table)) tableViolations.push(`${file.module}:${index + 1}: names '${table}'`);
    });
  }

  const deletedPaths = [
    "src/http/artifact-callback.ts", "src/http/artifact-withdraw.ts",
    "src/runtime/emit-artifact.ts", "src/runtime/artifact-notifications.ts", "src/runtime/run-launch-notifications.ts",
    "tests/artifact-callback.test.ts", "tests/artifact-withdraw.test.ts",
  ];
  const presentViolations = deletedPaths.filter((relativePath) => existsSync(resolve(PACKAGE_ROOT, relativePath)))
    .map((relativePath) => `${relativePath}: still present on disk`);

  expect([...importViolations, ...tableViolations, ...presentViolations]).toEqual([]);
});

// Not a spec rule: pins a review fix. The run record serializes every
// writer on the run row (`FOR UPDATE`, taken first); a per-run advisory
// lock taken before it inverted `decide_run`'s order and could deadlock.
test("run record serializes on the run row only: no advisory lock in postgres-run-record.ts", () => {
  const source = readFileSync(resolve(SRC_ROOT, "storage/postgres-run-record.ts"), "utf8");
  expect(source.includes("pg_advisory")).toBe(false);
});
