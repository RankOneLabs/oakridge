import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML, { type YAMLMap } from "yaml";
import { expandIncludes } from "./workflow-include";
import { discoverWorkflowSources } from "./workflow-sources";

test("includes prepend entries at each depth and resolve anchors locally", () => {
  const workflow = YAML.parseDocument("workflow: example\ninclude: [common.yaml]\nstages:\n  build:\n    2: &anchor local\n    1: *anchor\n");
  const result = expandIncludes(workflow, () =>
    YAML.parseDocument("stages:\n  prepare: &anchor shared\n  build:\n    9: *anchor\n"));
  if (!result.ok) throw new Error(result.error.detail);
  const stages = result.value.get("stages") as YAMLMap;
  expect(stages.items.map(({ key }) => String(key))).toEqual(["prepare", "build"]);
  expect((stages.get("build") as YAMLMap).items.map(({ key }) => String(key))).toEqual(["9", "2", "1"]);
  expect(result.value.toJS().stages.build).toEqual({ 9: "shared", 2: "local", 1: "local" });
  expect(result.value.has("include")).toBe(false);
  expect(workflow.has("include")).toBe(true);
});

test("a duplicate leaf is refused with its full path", () => {
  const result = expandIncludes(YAML.parseDocument("workflow: example\ninclude: [common.yaml]\ninput: { title: text }"),
    () => YAML.parseDocument("input: { title: ident }"));
  expect(result).toEqual({ ok: false, error: {
    operation: "expand_include", entity_id: "common.yaml",
    detail: "input.title is declared in both example and common.yaml",
  } });
});

test("includes cannot include other files", () => {
  const result = expandIncludes(YAML.parseDocument("include: [common.yaml]"),
    () => YAML.parseDocument("include: [nested.yaml]"));
  expect(result).toEqual({ ok: false, error: {
    operation: "expand_include", entity_id: "common.yaml", detail: "includes may not include other files",
  } });
});

type DeclarationPath = readonly string[];
function keys(node: unknown): string[] {
  return YAML.isMap(node) ? node.items.map(({ key }) => String(key)) : [];
}

function declarationPaths(document: YAML.Document): DeclarationPath[] {
  const roots = ["input", "schemas", "decisions", "workers", "reviews"];
  const topLevel = roots.flatMap((root) => keys(document.get(root)).map((key) => [root, key]));
  const stages = keys(document.get("stages")).flatMap((stage) => {
    const path = ["stages", stage];
    const sections = keys(document.getIn(path)).flatMap((section) => {
      const declaration = [...path, section];
      return [declaration, ...keys(document.getIn(declaration)).map((key) => [...declaration, key])];
    });
    return [path, ...sections];
  });
  return [...topLevel, ...stages];
}

test("authored workflows declare the same declaration path only once", () => {
  const root = resolve(import.meta.dir, "../..");
  const authored = discoverWorkflowSources(root).map(({ name, path }) => ({
    name, document: YAML.parseDocument(readFileSync(resolve(root, path), "utf8")),
  }));
  const exemptions = new Set(["assessment_subject", "completed_cohort", "plan_body"]);
  const duplicates = authored.flatMap(({ name, document }, index) =>
    authored.slice(index + 1).flatMap((other) =>
      declarationPaths(document).filter((path) => !exemptions.has(path.at(-1) ?? "")).flatMap((path) => {
        const left = document.getIn(path, true);
        const right = other.document.getIn(path, true);
        return YAML.isNode(left) && YAML.isNode(right) && isDeepStrictEqual(left.toJS(document), right.toJS(other.document))
          ? [`${path.join(".")} is declared in both ${name} and ${other.name}`] : [];
      })));
  expect(duplicates).toEqual([]);
});
