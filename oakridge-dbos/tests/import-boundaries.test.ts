import { expect, test } from "bun:test";
import { resolve, relative } from "node:path";
import { readFileSync } from "node:fs";
import { buildGraph, reachable, projectionViolations, mutationViolations, closedCommandViolations, evaluatorViolations, labels, authorityWriteSites, type ModuleNode, type ModuleGraph } from "./dependency-graph";

const root = resolve(import.meta.dir, "../..");
const dbosMain = resolve(root, "oakridge-dbos/src/main.ts");
const pwaMain = resolve(root, "kbbl/core/pwa/main.tsx");
const mutationEntry = resolve(root, "oakridge-dbos/src/storage/mutation-service.ts");
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
function mutationEntries(graph: ModuleGraph): readonly string[] {
  return [...graph.keys()].filter((path) => /^oakridge-dbos\/src\/(http|adapters|effects)\//.test(label(path)));
}
const projectionEntries = [...graph.keys()].filter((path) => label(path).startsWith("oakridge-dbos/src/projections/"));
test("pure projection graph reaches no external IO, including storage dependencies", () => {
  expect(projectionEntries.length).toBeGreaterThan(0);
  for (const entry of projectionEntries) expect(labels(root, projectionViolations(reachable(graph, entry)))).toEqual([]);
});
for (const path of ["oakridge-dbos/src/projections/injected.ts", "oakridge-dbos/src/storage/injected.ts"]) {
  test(`reachable IO at ${path} fails the production projection check`, () => {
    const start = resolve(root, "oakridge-dbos/src/projections/inbox.ts");
    const node = injected(path, "fetch('https://example.test')");
    expect(projectionViolations(reachable(injectDependency(graph, start, node), start))).toContainEqual({ path: node.path, detail: "projection calls IO capability fetch" });
  });
}
test("handlers, adapters and observers cannot reach domain writes without crossing the mutation service", () => {
  const entries = mutationEntries(graph);
  expect(entries.length).toBeGreaterThan(0);
  expect(labels(root, mutationViolations(graph, entries, mutationEntry))).toEqual([]);
});
test("state ownership inventory covers every production authority write with its named writer", () => {
  const inventory = readFileSync(resolve(root, "comms/oakridge-state-ownership-inventory.md"), "utf8");
  const sites = reachable(graph, dbosMain).flatMap(authorityWriteSites);
  expect(sites.length).toBeGreaterThan(0);
  for (const site of sites) {
    const row = inventory.split("\n").find((line) => line.includes(`${label(site.path)}:${site.line}`));
    expect(row, `missing ownership citation for ${site.writer} at ${label(site.path)}:${site.line}`).toBeDefined();
    expect(row).toContain(`\`${site.writer}\``);
  }
});
test("an additional production writer cannot hide behind existing inventory citations", () => {
  const node = injected("oakridge-dbos/src/effects/injected.ts", `
    export async function unlistedWriter(db: Executor) {
      await db.query("UPDATE authority.effect_intent SET version=version+1");
    }
  `);
  expect(authorityWriteSites(node)).toEqual([{ path: node.path, line: 3, writer: "unlistedWriter" }]);
});

test("an indirect storage write fails the mutation boundary, but one behind the service passes", () => {
  const http = resolve(root, "oakridge-dbos/src/http/app.ts");
  const node = injected("oakridge-dbos/src/storage/injected.ts", 'tx.query("UPDATE authority.scope_instance SET version=version+1")');
  const bad = injectDependency(graph, http, node);
  expect(mutationViolations(bad, [http], mutationEntry)).toContainEqual({ path: node.path, detail: "domain write to authority.scope_instance bypasses mutation service" });
  const good = injectDependency(graph, mutationEntry, node);
  expect(mutationViolations(good, [http], mutationEntry)).toEqual([]);
});
test("the active PWA cannot import backend workflow authority or the removed command protocol", () => {
  const nodes = reachable(graph, pwaMain);
  expect(nodes.map((node) => label(node.path)).filter((path) => path.startsWith("oakridge-dbos/src/") || path.startsWith("kbbl/core/server/"))).toEqual([]);
  expect(labels(root, closedCommandViolations(nodes))).toEqual([]);
});
test("an injected closed command vocabulary fails the PWA boundary", () => {
  const node = injected("kbbl/core/pwa/oakridge/injected.ts", 'type OperatorRequest = { kind: "accept_plan"; target: string } | { kind: "retry_build" };');
  expect(closedCommandViolations(reachable(injectDependency(graph, pwaMain, node), pwaMain))).toContainEqual({ path: node.path, detail: "closed workflow command type OperatorRequest" });
});
test("an injected second evaluator path outside mutations fails the boundary", () => {
  const node = injected("oakridge-dbos/src/http/injected.ts", 'core.request("evaluate", snapshot)');
  const bad = injectDependency(graph, dbosMain, node);
  const approved = new Set(reachable(bad, mutationEntry).map((item) => item.path));
  expect(evaluatorViolations(reachable(bad, dbosMain), approved)).toContainEqual({ path: node.path, detail: "evaluator call bypasses mutation service" });
});

import { rustLibraryGraph, rustCapabilityViolations, workflowLiteralViolations } from "./rust-boundary";
test("reachable Rust library modules and Cargo dependencies have no declared IO capability", () => {
  const files = rustLibraryGraph(root);
  expect(files.length).toBeGreaterThan(10);
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
test("Rust library contains no workflow identifiers, including indirect multiline branches", () => {
  expect(rustLibraryGraph(root).flatMap((file) => workflowLiteralViolations(readFileSync(file, "utf8")).map((name) => `${label(file)}: ${name}`))).toEqual([]);
  expect(workflowLiteralViolations('const NAME: &str = "assessment"; if\n name == NAME\n { work(); }')).toEqual(["assessment"]);
  expect(workflowLiteralViolations('match name {\n r#"build"#\n => work(), _ => () }')).toEqual(["build"]);
});

test("a renamed untyped retired request constructor fails the PWA boundary", () => {
  const node = injected("kbbl/core/pwa/oakridge/injected.ts", 'const renamed = { kind: "retry_build" };');
  expect(closedCommandViolations(reachable(injectDependency(graph, pwaMain, node), pwaMain))).toContainEqual({ path: node.path, detail: "retired workflow request constructor retry_build" });
});
test("aliasing an IO function cannot conceal it from a projection boundary", () => {
  const node = injected("oakridge-dbos/src/projections/injected.ts", 'const load = fetch; load(url);');
  expect(projectionViolations([node])).toContainEqual({ path: node.path, detail: "projection references IO capability fetch" });
});

test("opaque SQL assembled by an indirect helper fails closed", () => {
  const entry = resolve(root, "oakridge-dbos/src/http/app.ts");
  const node = injected("oakridge-dbos/src/storage/injected.ts", 'const verb = "UPDATE"; tx.query(verb + " authority.run SET version=1");');
  expect(mutationViolations(injectDependency(graph, entry, node), [entry], mutationEntry)).toContainEqual({ path: node.path, detail: "unresolved SQL statement bypasses mutation service" });
});

test("an interpolated SQL verb cannot bypass the indirect mutation boundary", () => {
  const entry = resolve(root, "oakridge-dbos/src/http/app.ts");
  const node = injected("oakridge-dbos/src/storage/injected.ts", 'const verb = "UPDATE"; tx.query(`${verb} authority.run SET version=1`);');
  expect(mutationViolations(injectDependency(graph, entry, node), [entry], mutationEntry)).toContainEqual({ path: node.path, detail: "unresolved SQL statement bypasses mutation service" });
});
test("plain backtick SQL remains inspectable without interpolation", () => {
  const node = injected("oakridge-dbos/src/storage/injected.ts", 'tx.query(`UPDATE authority.run SET version=1`);');
  expect(mutationViolations(new Map([[node.path, node]]), [node.path], mutationEntry)).toContainEqual({ path: node.path, detail: "domain write to authority.run bypasses mutation service" });
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
    expect(workflowLiteralViolations(source)).toEqual(["plan"]);
  });
}
test("skipping an inline test module preserves the following production workflow literal", () => {
  const source = '#[cfg(test)] mod tests { fn test_only() { std::net::TcpStream::connect("build"); } } const NAME: &str = "assessment";';
  expect(workflowLiteralViolations(source)).toEqual(["assessment"]);
});
