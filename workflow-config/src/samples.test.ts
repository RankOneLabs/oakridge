import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { WORKFLOW_SOURCES, definitionBytes, definitionId, type DefinitionContent } from "./workflow-sources";
import { listPromptCatalog } from "./prompt-catalog";
import type { AuthoredWorkflow } from "../../oakridge-dbos/src/core-client/core-types";
import { OPERATION_REGISTRY } from "../../oakridge-dbos/src/operations/registry";
import { selectPromptPaths } from "../../oakridge-dbos/src/runtime/prompt-files";
import { canonicalJson } from "canonical-json";

const root = resolve(import.meta.dir, "../..");
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

test("definition identity follows prompt and registry bytes, not YAML key order", () => {
  const first = YAML.parse("workflow: example\ninput: {}\nrun: {units: {}, outcome: {}}\nstages: {}\n") as AuthoredWorkflow;
  const reordered = YAML.parse("stages: {}\nrun: {outcome: {}, units: {}}\ninput: {}\nworkflow: example\n") as AuthoredWorkflow;
  const registry = digest("registry");
  const content: DefinitionContent = { source: { ...first, operations: registry }, operations: registry, prompts: { "a.md": digest("first\n") } };
  const same: DefinitionContent = { ...content, source: { ...reordered, operations: registry } };
  expect(definitionId(content).ok).toBe(true);
  expect(definitionBytes(content)).toEqual(definitionBytes(same));
  expect(definitionId(content)).toEqual(definitionId(same));
  expect(definitionId({ ...content, prompts: { "a.md": digest("second\n") } })).not.toEqual(definitionId(content));
  const changed = digest("changed registry");
  expect(definitionId({ ...content, source: { ...first, operations: changed }, operations: changed })).not.toEqual(definitionId(content));
});

test("definition transforms return canonicalization failures as values", () => {
  const invalid = { source: { workflow: "invalid", input: {}, run: { units: {}, outcome: {} }, stages: {} },
    operations: "registry", prompts: { "a.md": Number.NaN as unknown as string } } as DefinitionContent;
  expect(definitionBytes(invalid)).toMatchObject({ ok: false, error: { operation: "canonical_json", entity_id: "/prompts/a.md" } });
  expect(definitionId(invalid)).toEqual(definitionBytes(invalid));
});

test("generated prompt objects preserve their source bytes", () => {
  const catalog = JSON.parse(readFileSync(resolve(root, "definitions/launchable.json"), "utf8")) as { [name: string]: string };
  for (const id of Object.values(catalog)) {
    const definition = JSON.parse(readFileSync(resolve(root, "definitions/workflows", `${id}.json`), "utf8")) as DefinitionContent;
    for (const [path, promptId] of Object.entries(definition.prompts))
      expect(readFileSync(resolve(root, "definitions/prompts", `${promptId}.md`)))
        .toEqual(readFileSync(resolve(root, "workflow-config/prompts", path)));
  }
});

test("the generator pins a worker template override instead of its default prompt", () => {
  const catalog = JSON.parse(readFileSync(resolve(root, "definitions/launchable.json"), "utf8")) as { [name: string]: string };
  const definition = JSON.parse(readFileSync(resolve(root, "definitions/workflows", `${catalog["template-override"]}.json`), "utf8")) as DefinitionContent;
  const path = "template-override/override.md";
  const source = readFileSync(resolve(root, "workflow-config/prompts", path));
  expect(definition.source.stages.document?.workers.writer).toEqual({ template: "writer", overrides: { prompts: { initial: path } } });
  expect(definition.prompts).toEqual({ [path]: createHash("sha256").update(source).digest("hex") });
  expect(readFileSync(resolve(root, "definitions/prompts", `${definition.prompts[path]}.md`))).toEqual(source);
});

// The Rust compiler and replay tests read the JSON; the YAML is what a person
// edits. These assertions are what generate.ts --check enforces in CI.
for (const [name, path] of Object.entries(WORKFLOW_SOURCES)) {
  test(`${name}.json is the committed derivation of ${path}`, () => {
    const source = readFileSync(resolve(root, path), "utf8");
    const document = YAML.parseDocument(source, { uniqueKeys: true });
    expect(document.errors).toEqual([]);
    const fixture = readFileSync(resolve(root, "workflow-core/fixtures/bundles", `${name}.json`), "utf8");
    const registry = canonicalJson(OPERATION_REGISTRY);
    if (!registry.ok) throw new Error(registry.error.detail);
    expect(fixture).toBe(`${JSON.stringify({ ...document.toJS(), operations: digest(registry.value) }, null, 2)}\n`);
  });

  test(`${path} names only prompt files that exist`, () => {
    const workflow = YAML.parse(readFileSync(resolve(root, path), "utf8")) as AuthoredWorkflow;
    const referenced = selectPromptPaths(workflow);
    expect(referenced.length).toBeGreaterThan(0);
    for (const path of referenced)
      expect(() => readFileSync(resolve(root, "workflow-config/prompts", path))).not.toThrow();
  });
}

test("development reviews analysis, specification, and tasks before planning", () => {
  interface DevelopmentSpecFlow {
    readonly run: { readonly units: { readonly planning: { readonly input: { readonly spec: string; readonly tasks: string;
      readonly repositories: string; readonly repository_key: string; readonly workspace: string } };
      readonly briefs: { readonly input: { readonly spec: string } } } };
    readonly stages: { readonly analysis: { readonly artifacts: { readonly analysis: { readonly schema: string }; readonly spec: { readonly schema: string };
      readonly tasks: { readonly schema: string } };
      readonly workers: { readonly author: { readonly creates: string[] }; readonly spec_editor: { readonly when: string; readonly creates: string[] } };
      readonly reviews: { readonly analysis_review: { readonly of: string }; readonly spec_review: { readonly of: string };
        readonly tasks_review: { readonly of: string } };
      readonly done_when: string; readonly outcome: { readonly spec: string; readonly tasks: string } } };
  }
  const workflow = YAML.parse(readFileSync(resolve(root, WORKFLOW_SOURCES.development), "utf8")) as DevelopmentSpecFlow;
  const analysis = workflow.stages.analysis;
  expect(Object.keys(analysis.workers).sort()).toEqual(["author", "spec_editor"]);
  expect({ artifacts: analysis.artifacts, author: analysis.workers.author.creates,
    editor: { when: analysis.workers.spec_editor.when, creates: analysis.workers.spec_editor.creates },
    review: analysis.reviews.analysis_review.of, specReview: analysis.reviews.spec_review.of, tasksReview: analysis.reviews.tasks_review.of,
    done_when: analysis.done_when, outcome: analysis.outcome,
    planning: workflow.run.units.planning.input, brief: workflow.run.units.briefs.input.spec })
    .toEqual({ artifacts: { analysis: { schema: "analysis_body" }, spec: { schema: "text" }, tasks: { schema: "tasks_body" } },
      author: ["analysis"], editor: { when: "approved(analysis)", creates: ["spec", "tasks"] },
      review: "analysis", specReview: "spec", tasksReview: "tasks",
      done_when: "approved(analysis) and approved(spec) and approved(tasks)", outcome: { spec: "latest(spec)", tasks: "latest(tasks)" },
      planning: { spec: "analysis.outcome.spec", tasks: "analysis.outcome.tasks", repositories: "input.repositories",
        repository_key: "input.primary_repository_key", workspace: "require(lookup(map(prepare, prepare.outcome), key, input.primary_repository_key)).workspace" },
      brief: "analysis.outcome.spec" });
});

test("a duplicate key in a sample is an error rather than a silent overwrite", () => {
  const document = YAML.parseDocument("workflow: a\nworkflow: b\n", { uniqueKeys: true });
  expect(document.errors.length).toBeGreaterThan(0);
});

let prompt_root: string;
let previous_root: string | undefined;
beforeEach(() => {
  prompt_root = mkdtempSync(resolve(tmpdir(), "oakridge-prompt-root-"));
  mkdirSync(resolve(prompt_root, "workflow-config/prompts/development"), { recursive: true });
  previous_root = process.env.OAKRIDGE_PROMPT_ROOT;
  process.env.OAKRIDGE_PROMPT_ROOT = prompt_root;
});
afterEach(() => {
  if (previous_root === undefined) delete process.env.OAKRIDGE_PROMPT_ROOT;
  else process.env.OAKRIDGE_PROMPT_ROOT = previous_root;
  rmSync(prompt_root, { recursive: true, force: true });
});

test("the catalog lists every allowlisted file with its server-computed digest", () => {
  writeFileSync(resolve(prompt_root, "workflow-config/prompts/development/build.md"), "One.\n");
  writeFileSync(resolve(prompt_root, "workflow-config/prompts/review-loop.md"), "Two.\n");
  expect(listPromptCatalog()).toEqual([
    { key: "workflow-config/prompts/development/build.md", path: "workflow-config/prompts/development/build.md", content_digest: digest("One.\n") },
    { key: "workflow-config/prompts/review-loop.md", path: "workflow-config/prompts/review-loop.md", content_digest: digest("Two.\n") },
  ]);
});
