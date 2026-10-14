import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Workflow } from "../src/core-client/core-types";
import { selectDefinitionBundle } from "../src/projections/definition-view";
import { parseType, schemaKey, selectDecisionPayloadType, selectWorkflowSchemas, typeSchemaKey } from "../src/projections/schema-view";

const workflow: Workflow = {
  workflow: "development",
  input: { spec: "text", repositories: "list(repository)" },
  schemas: { repository: { owner: "ident", name: "ident", path: "optional(repo_path)" }, plan_body: { summary: "text" }, plan: "plan_body" },
  run: { units: { planning: { stage: "planning", input: {} } }, outcome: {} },
  stages: {
    planning: {
      input: {}, outcome: {}, workers: {},
      artifacts: { plan: { schema: "plan" }, notes: { schema: "{count: integer, done: boolean}" } },
      reviews: { chief: { of: "plan", by: "operator", inputs: {}, decisions: {
        approve: { effect: "approve", label: "Approve" },
        request_changes: { effect: "request_changes", label: "Request changes", fields: { feedback: "What should change?", scope: "Which part?" } },
        grade: { effect: "approve", label: "Grade", payload: { score: "integer" } },
      } } },
    },
  },
};
const schemas = selectWorkflowSchemas(workflow);
const shape = (key: string) => schemas.find((schema) => schema.key === key)?.shape;

test("a record expression and its inline form share one canonical key, fields sorted", () => {
  expect([typeSchemaKey({ b: "text", a: "list(ident)" }), typeSchemaKey("{ b: text, a: list(ident) }")]).toEqual(["{a: list(ident), b: text}", "{a: list(ident), b: text}"]);
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
  expect({ key: schemaKey(parseType("enum(fast, safe)")), shape: selectWorkflowSchemas({ ...workflow, input: { mode: "enum(fast, safe)" } })
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

test("a member key two groups reuse keeps a bundle unit per declaration, so the development bundle lists every stage", () => {
  const development = JSON.parse(readFileSync(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/development.json"), "utf8")) as Workflow;
  expect(selectDefinitionBundle(development).units.map((unit) => [unit.key, unit.stage])).toEqual([["$root", null],
    ["prepare/repository", "prepare"], ["analysis", "analysis"], ["planning", "planning"], ["briefs/brief", "brief"],
    ["implementation/cohort", "cohort"], ["integration/repository", "integration"]]);
});
