import { expect, test } from "bun:test";
import { resolve, relative } from "node:path";
import { readFileSync } from "node:fs";
import { buildGraph, reachable, projectionViolations, evaluatorViolations, labels, type ModuleNode, type ModuleGraph } from "./dependency-graph";

const root = resolve(import.meta.dir, "../..");
const dbosMain = resolve(root, "oakridge-dbos/src/main.ts");
const pwaMain = resolve(root, "kbbl/core/pwa/main.tsx");
/** Commit steps the core and the core client compiles; nothing else calls it. */
const coreCallers = new Set([resolve(root, "oakridge-dbos/src/storage/commit.ts"), resolve(root, "oakridge-dbos/src/core-client/client.ts")]);
const graph = buildGraph([dbosMain, pwaMain]);
const label = (path: string) => relative(root, path);
function injectDependency(graph: ModuleGraph, entry: string, node: ModuleNode): ModuleGraph {
  const owner = graph.get(entry);
  if (!owner) throw new Error(`missing injection entry ${entry}`);
  const injected = new Map(graph);
  injected.set(node.path, node);
  injected.set(entry, { ...owner, imports: [...owner.imports, node.path] });
  return injected;
}
function injected(path: string, source: string): ModuleNode {
  return { path: resolve(root, path), source, imports: [], packages: [] };
}
const projectionEntries = [...graph.keys()].filter((path) => label(path).startsWith("oakridge-dbos/src/projections/"));
test("pure projection graph reaches no external IO, including storage dependencies", () => {
  expect(projectionEntries.length).toBeGreaterThan(0);
  for (const entry of projectionEntries) expect(labels(root, projectionViolations(reachable(graph, entry)))).toEqual([]);
});
for (const path of ["oakridge-dbos/src/projections/injected.ts", "oakridge-dbos/src/storage/injected.ts"]) {
  test(`reachable IO at ${path} fails the production projection check`, () => {
    const start = resolve(root, "oakridge-dbos/src/projections/run-view.ts");
    const node = injected(path, "fetch('https://example.test')");
    expect(projectionViolations(reachable(injectDependency(graph, start, node), start))).toContainEqual({ path: node.path, detail: "projection calls IO capability fetch" });
  });
}
test("the active PWA cannot import backend workflow authority or the removed command protocol", () => {
  const nodes = reachable(graph, pwaMain);
  expect(nodes.map((node) => label(node.path)).filter((path) => path.startsWith("oakridge-dbos/src/") || path.startsWith("kbbl/core/server/"))).toEqual([]);
});
test("core calls stay in commit and the core client, and an injected one elsewhere fails", () => {
  expect(labels(root, evaluatorViolations(reachable(graph, dbosMain), coreCallers))).toEqual([]);
  const node = injected("oakridge-dbos/src/http/injected.ts", 'core.request("step", input)');
  const bad = injectDependency(graph, dbosMain, node);
  expect(evaluatorViolations(reachable(bad, dbosMain), coreCallers)).toContainEqual({ path: node.path, detail: "core call outside commit and the core client" });
});

import { rustLibraryGraph, rustCapabilityViolations, selectDeclaredNames, workflowLiteralViolations } from "./rust-boundary";
import type { Workflow } from "../src/core-client/core-types";
const DEVELOPMENT_NAMES = selectDeclaredNames(Bun.YAML.parse(readFileSync(resolve(import.meta.dir, "../../workflow-config/development.yaml"), "utf8")) as Workflow);
test("reachable Rust library modules and Cargo dependencies have no declared IO capability", () => {
  const files = rustLibraryGraph(root);
  expect(files.length).toBeGreaterThan(5);
  expect(files.flatMap((file) => rustCapabilityViolations(readFileSync(file, "utf8")).map((detail) => `${label(file)}: ${detail}`))).toEqual([]);
  const forbiddenCrate = /^\s*(?:tokio|reqwest|ureq|rand|getrandom|chrono|postgres|sqlx|rusqlite|diesel)\s*=/m;
  expect(["model", "compiler", "evaluator"].filter((name) => forbiddenCrate.test(readFileSync(resolve(root, `workflow-core/crates/${name}/Cargo.toml`), "utf8")))).toEqual([]);
});
test("Rust capability checks catch grouped and aliased multiline imports", () => {
  expect(rustCapabilityViolations('use std::{\n fs as disk\n}; disk::read("x");')).not.toEqual([]);
  expect(rustCapabilityViolations('use std as platform; platform::net::connect();')).not.toEqual([]);
  expect(rustCapabilityViolations('use std::time::SystemTime as Clock; Clock::now();')).not.toEqual([]);
  expect(rustCapabilityViolations('use std::collections::HashSet; let set = HashSet::new();')).toContain("randomly seeded collection");
});
test("Rust library contains none of the development workflow's identifiers, including indirect multiline branches", () => {
  expect(rustLibraryGraph(root).flatMap((file) => workflowLiteralViolations(readFileSync(file, "utf8"), DEVELOPMENT_NAMES).map((name) => `${label(file)}: ${name}`))).toEqual([]);
  expect(workflowLiteralViolations('const NAME: &str = "assessment"; if\n name == NAME\n { work(); }', DEVELOPMENT_NAMES)).toEqual(["assessment"]);
  expect(workflowLiteralViolations('match name {\n r#"builder"#\n => work(), _ => () }', DEVELOPMENT_NAMES)).toEqual(["builder"]);
});

test("aliasing an IO function cannot conceal it from a projection boundary", () => {
  const node = injected("oakridge-dbos/src/projections/injected.ts", 'const load = fetch; load(url);');
  expect(projectionViolations([node])).toContainEqual({ path: node.path, detail: "projection references IO capability fetch" });
});

for (const item of [
  "mod tests;",
  "const VALUE: usize = 1;",
  "const VALUE: usize = { let nested = { 1 }; nested };",
  "static VALUE: usize = 1;",
  "type Value = [u8; 4];",
  "use std::{fs, net};",
  "struct Value(u8);",
  "#[test] fn test_only() { std::net::TcpStream::connect(\"test\"); }",
  "const fn test_only() -> usize { 1 }",
]) {
  test(`cfg-gated ${item} cannot hide the next production item`, () => {
    const source = `#[cfg(test)] ${item} fn production() { std::fs::read(\"plan\"); }`;
    expect(rustCapabilityViolations(source)).toEqual(["external std capability"]);
    expect(workflowLiteralViolations(source, DEVELOPMENT_NAMES)).toEqual(["plan"]);
  });
}
test("skipping an inline test module preserves the following production workflow literal", () => {
  const source = '#[cfg(test)] mod tests { fn test_only() { std::net::TcpStream::connect("build"); } } const NAME: &str = "assessment";';
  expect(workflowLiteralViolations(source, DEVELOPMENT_NAMES)).toEqual(["assessment"]);
});
test("an exported WASM ABI function is allowed, but a foreign import block is not", () => {
  expect(rustCapabilityViolations('#[unsafe(no_mangle)] pub extern "C" fn core_alloc(len: usize) -> *mut u8 { todo!() }')).toEqual([]);
  expect(rustCapabilityViolations('extern "C" { fn host_clock() -> u64; }')).toEqual(["unresolved external code or environment capability"]);
});
