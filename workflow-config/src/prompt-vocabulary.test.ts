import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import YAML from "yaml";
import { CORE_ASSESSMENT_SCHEMAS } from "../../oakridge-dbos/src/core-client/core-types";
import { decodeWorkflowSource, type WorkflowDefinitionDescriptor } from "../../oakridge-dbos/src/core-client/source-types";
import { composePrompts } from "../../oakridge-dbos/src/runtime/definition-store";
import { referencedPromptPaths } from "./definition-objects";
import { expandIncludes } from "./workflow-include";
import { discoverWorkflowSources } from "./workflow-sources";

const identifier = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const fieldList = /^\{\s*[a-z][a-z0-9_]*\??(\s*,\s*[a-z][a-z0-9_]*\??)*\s*\}$/;
const retired = /pick a sensible path|\btasks\b|task_ids|tasks_review|acceptance_criteria|approaches_rejected|dependency_order|recommended_next_actions|needs_decision|subjects|builder_feedback|audience: builder|rework_feedback|feedback_field|next_actions|action_disposition|added_action/g;

function quotedTokens(markdown: string): string[] {
  // Treat a balanced run of backticks as one span. Skip fenced code.
  return [...markdown.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, "").matchAll(/(?<!`)(`+)([^`]+)\1(?!`)/g)]
    .flatMap(([, , span]) => identifier.test(span) ? [span]
      : fieldList.test(span) ? span.slice(1, -1).split(",").map((field) => field.trim().replace(/\?$/, "")) : []);
}

function vocabulary(source: WorkflowDefinitionDescriptor): ReadonlySet<string> {
  const allowed = new Set<string>();
  function addKeys(fields: object | undefined | null) {
    for (const key of Object.keys(fields ?? {})) allowed.add(key);
  }
  function addExpression(expression: string) {
    for (const [, field] of expression.matchAll(/[{,]\s*([a-z][a-z0-9_]*)\s*:/g)) allowed.add(field);
    for (const [, values] of expression.matchAll(/\benum\(([^()]*)\)/g)) {
      for (const value of values.split(",")) allowed.add(value.trim());
    }
  }
  function addType(type: WorkflowDefinitionDescriptor["input"] | undefined | null) {
    if (typeof type === "string") addExpression(type);
    else if (type) {
      addKeys(type);
      for (const field of Object.values(type)) addType(field);
    }
  }
  const schemas = { ...CORE_ASSESSMENT_SCHEMAS, ...source.schemas };
  addKeys(schemas);
  for (const type of Object.values(schemas)) addType(type);
  addType(source.input);
  addKeys(source.stages);
  addKeys(source.workers);
  addKeys(source.reviews);
  addKeys(source.decisions);
  for (const decisions of Object.values(source.decisions ?? {})) addKeys(decisions);
  for (const stage of Object.values(source.stages)) {
    addType(stage.input);
    addKeys(stage.let);
    addKeys(stage.artifacts);
    addKeys(stage.workers);
    addKeys(stage.reviews);
    addKeys(stage.outcome);
    for (const expression of Object.values(stage.outcome)) addExpression(expression);
    for (const artifact of Object.values(stage.artifacts)) addType(artifact.schema);
  }
  for (const workers of [source.workers, ...Object.values(source.stages).map((stage) => stage.workers)]) {
    for (const worker of Object.values(workers ?? {})) {
      const inputs = "kind" in worker ? worker.inputs : worker.overrides?.inputs;
      addKeys(inputs);
      for (const expression of Object.values(inputs ?? {})) addExpression(expression);
    }
  }
  for (const reviews of [source.reviews, ...Object.values(source.stages).map((stage) => stage.reviews)]) {
    for (const review of Object.values(reviews ?? {})) {
      const declaration = "by" in review ? review : review.overrides;
      addKeys(declaration?.inputs);
      for (const expression of Object.values(declaration?.inputs ?? {})) addExpression(expression);
      const decisions = declaration?.decisions;
      if (decisions && typeof decisions.set !== "string") {
        addKeys(decisions);
        for (const decision of Object.values(decisions)) {
          if (typeof decision === "object" && decision && "payload" in decision) addType(decision.payload as WorkflowDefinitionDescriptor["input"]);
          if (typeof decision === "object" && decision && "fields" in decision) addKeys(decision.fields as object);
        }
      }
    }
  }
  addKeys(source.run.outcome);
  return allowed;
}

const root = resolve(import.meta.dir, "../..");
const prompts = resolve(root, "workflow-config/prompts");
const promptTexts = Object.fromEntries(readdirSync(prompts, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => {
    const path = resolve(entry.parentPath, entry.name);
    return [relative(prompts, path), readFileSync(path, "utf8")];
  }));

for (const { name, path } of discoverWorkflowSources(root)) test(`${name} prompts use declared vocabulary`, () => {
  const expanded = expandIncludes(YAML.parseDocument(readFileSync(resolve(root, path), "utf8")),
    (include) => YAML.parseDocument(readFileSync(resolve(root, "workflow-config", include), "utf8")));
  if (!expanded.ok) throw new Error(expanded.error.detail);
  const source = decodeWorkflowSource(expanded.value.toJS());
  if (!source) throw new Error(`Invalid workflow ${path}`);
  const composed = composePrompts(referencedPromptPaths(source), promptTexts);
  if (!composed.ok) throw new Error(composed.error.detail);
  const allowed = vocabulary(source);
  const errors = Object.entries(composed.value.prompts).flatMap(([path, { text }]) => [
    ...[...new Set(quotedTokens(text))].filter((token) => !allowed.has(token))
      .map((token) => `${path}: \`${token}\` is not a field, enum value or declared key of ${name}`),
    ...[...text.matchAll(retired)].filter((match) =>
      match[0] !== "subjects" || text.slice(match.index - "related_".length, match.index) !== "related_")
      .map((match) => `${path}: retired vocabulary ${match[0]}`),
  ]);
  expect(errors).toEqual([]);
});

test("quoted vocabulary checks individual identifiers and field lists", () => {
  expect(quotedTokens("`not_a_field_xyz` `{field,\noptional_field?}` `docker ps` `~/apps/x`"))
    .toEqual(["not_a_field_xyz", "field", "optional_field"]);
});
