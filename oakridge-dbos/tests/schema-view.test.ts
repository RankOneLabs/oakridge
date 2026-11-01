import { OPERATION_REGISTRY } from "../src/operations/registry";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthoredWorkflow, ParsedWorkflow, Type, Workflow } from "../src/core-client/core-types";
import { compileWorkflow, CoreClient } from "../src/core-client/client";
import { selectDefinitionBundle } from "../src/projections/definition-view";
import { typeNode, schemaKey, selectDecisionPayloadType, selectWorkflowSchemas, typeSchemaKey } from "../src/projections/schema-view";
import { readWorkflowPrompts, selectPromptPaths } from "../src/runtime/prompt-files";

test("prompt discovery applies worker and review template overrides", () => {
  const source: AuthoredWorkflow = {
    workflow: "template_prompts", input: {}, run: { units: {}, outcome: {} },
    workers: { writer: { kind: "agent", prompts: { initial: "unused.md" }, inputs: {}, creates: [] } },
    reviews: { approval: { of: "draft", by: "operator", prompt: "unused-review.md", decisions: {} } },
    stages: { draft: { input: {}, artifacts: {}, outcome: {}, workers: {
      writer: { template: "writer", overrides: { prompts: { initial: "used.md" } } } },
      reviews: { approval: { template: "approval", overrides: { prompt: "used-review.md" } } } } },
  };
  expect(selectPromptPaths(source)).toEqual(["used-review.md", "used.md"]);
});

const workflow: ParsedWorkflow = {
  workflow: "development",
  input: { kind: "record", fields: { spec: { kind: "text" }, repositories: { kind: "list", item: { kind: "named", schema: "repository" } } } },
  schemas: { repository: { kind: "record", fields: { owner: { kind: "ident" }, name: { kind: "ident" },
    path: { kind: "optional", value: { kind: "repo_path" } } } },
  plan_body: { kind: "record", fields: { summary: { kind: "text" } } }, plan: { kind: "named", schema: "plan_body" } },
  run: { units: { planning: { stage: "planning", input: {} } }, outcome: {} },
  stages: {
    planning: {
      input: { kind: "record", fields: {} }, outcome: {}, workers: {},
      artifacts: { plan: { schema: { kind: "named", schema: "plan" } }, notes: { schema: { kind: "record", fields: {
        count: { kind: "integer" }, done: { kind: "boolean" } } } } },
      reviews: { chief: { of: "plan", by: "operator", inputs: {}, decisions: {
        approve: { effect: "approve", label: "Approve" },
        request_changes: { effect: "request_changes", label: "Request changes", fields: { feedback: "What should change?", scope: "Which part?" } },
        grade: { effect: "approve", label: "Grade", payload: { kind: "record", fields: { score: { kind: "integer" } } } },
      } } },
    },
  },
};
const schemas = selectWorkflowSchemas(workflow);
const shape = (key: string) => schemas.find((schema) => schema.key === key)?.shape;

test("tagged contract types project without reading compact syntax", () => {
  expect(typeSchemaKey({ kind: "record", fields: { b: { kind: "list", item: { kind: "ident" } }, a: { kind: "text" } } }))
    .toBe("{a: text, b: list(ident)}");
});

test("an alias keeps its name; an alias of an alias takes the shape it resolves to", () => {
  expect({ plan: shape("plan"), plan_body: shape("plan_body") }).toEqual({
    plan: { kind: "record", fields: [{ key: "summary", schema: "text" }] },
    plan_body: { kind: "record", fields: [{ key: "summary", schema: "text" }] } });
});

test("an optional field admits null, and nested lists and optionals get their own schemas", () => {
  expect({ repository: shape("repository"), list: shape("list(repository)"), optional: shape("optional(repo_path)"), path: shape("repo_path") }).toEqual({
    repository: { kind: "record", fields: [{ key: "name", schema: "ident" }, { key: "owner", schema: "ident" },
      { key: "path", schema: "optional(repo_path)" }] },
    list: { kind: "list", item: "repository", max_items: Number.MAX_SAFE_INTEGER },
    optional: { kind: "optional", item: "repo_path" },
    path: { kind: "string", min_length: 0, max_length: Number.MAX_SAFE_INTEGER } });
});

test("primitives map to the PWA's shapes, with the core's ident bound", () => {
  expect({ ident: shape("ident"), integer: shape("integer"), boolean: shape("boolean") }).toEqual({
    ident: { kind: "string", min_length: 1, max_length: 100 },
    integer: { kind: "integer", min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
    boolean: { kind: "boolean" } });
});

test("an enum expression becomes the PWA's enum shape", () => {
  const type: Type = { kind: "enum", variants: ["fast", "safe"] };
  expect({ key: schemaKey(typeNode(type)), shape: selectWorkflowSchemas({ ...workflow, input: { kind: "record", fields: { mode: type } } })
    .find((schema) => schema.key === "enum(fast, safe)")?.shape }).toEqual({ key: "enum(fast, safe)", shape: { kind: "enum", variants: ["fast", "safe"] } });
});

test("a decision's payload: its declared type, its text fields, and feedback for request_changes", () => {
  const decisions = workflow.stages.planning!.reviews!.chief!.decisions;
  expect(Object.values(decisions).map((decision) => schemaKey(selectDecisionPayloadType(decision))))
    .toEqual(["{}", "{feedback: text, scope: text}", "{score: integer}"]);
});

test("every schema the bundle references is listed exactly once", () => {
  const keys = schemas.map((schema) => schema.key);
  const bundle = selectDefinitionBundle(workflow);
  const referenced = [...bundle.units.map((unit) => unit.input_schema), ...bundle.units.flatMap((unit) => unit.artifacts.map((artifact) => artifact.schema)),
    ...schemas.flatMap((schema) => schema.shape.kind === "record" ? schema.shape.fields.map((field) => field.schema)
      : schema.shape.kind === "list" || schema.shape.kind === "optional" ? [schema.shape.item] : [])];
  expect({ unique: new Set(keys).size === keys.length, missing: referenced.filter((key) => !keys.includes(key)) }).toEqual({ unique: true, missing: [] });
});

test("the bundle lists the root with the run input and each staged unit with its artifacts", () => {
  const bundle = selectDefinitionBundle(workflow);
  expect({ key: bundle.key, root: bundle.root,
    units: bundle.units.map((unit) => [unit.key, unit.input_schema, unit.label, unit.artifacts.map((artifact) => [artifact.key, artifact.schema])]) })
    .toEqual({ key: "development", root: "$root", units: [
      ["$root", "{repositories: list(repository), spec: text}", "Development", []],
      ["planning", "{}", "Planning", [["notes", "{count: integer, done: boolean}"], ["plan", "plan"]]]] });
});

test("the development bundle lists each direct collection declaration", async () => {
  const source = JSON.parse(readFileSync(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/development.json"), "utf8")) as Workflow;
  const prompts = readWorkflowPrompts(source);
  if (!prompts.ok) throw new Error(prompts.error.detail);
  const started = CoreClient.start();
  if (!started.ok) throw new Error(started.error.detail.detail);
  try {
    const compiled = await compileWorkflow(started.value, { workflow: source,
      prompts: Object.fromEntries(Object.entries(prompts.value).map(([path, prompt]) => [path, prompt.content])), operations: OPERATION_REGISTRY });
    if (!compiled.ok) throw new Error(compiled.error.detail);
    expect(selectDefinitionBundle(compiled.value.workflow, source).units.map((unit) => [unit.key, unit.stage])).toEqual([["$root", null],
    ["prepare", "prepare"], ["analysis", "analysis"], ["planning", "planning"], ["briefs", "brief"],
    ["implementation", "cohort"], ["integration", "integration"]]);
  } finally { started.value.close(); }
});
