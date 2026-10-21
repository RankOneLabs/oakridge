import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { WORKFLOW_SOURCES } from "./workflow-sources";
import { listPromptCatalog } from "./prompt-catalog";

const root = resolve(import.meta.dir, "../..");
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

// The Rust compiler and replay tests read the JSON; the YAML is what a person
// edits. These assertions are what generate.ts --check enforces in CI.
for (const [name, path] of Object.entries(WORKFLOW_SOURCES)) {
  test(`${name}.json is the committed derivation of ${path}`, () => {
    const source = readFileSync(resolve(root, path), "utf8");
    const document = YAML.parseDocument(source, { uniqueKeys: true });
    expect(document.errors).toEqual([]);
    const fixture = readFileSync(resolve(root, "workflow-core/fixtures/bundles", `${name}.json`), "utf8");
    expect(fixture).toBe(`${JSON.stringify(document.toJS(), null, 2)}\n`);
  });

  test(`${path} names only prompt files that exist`, () => {
    const workflow = YAML.parse(readFileSync(resolve(root, path), "utf8")) as {
      stages: Record<string, { workers: Record<string, { prompts?: Record<string, string> }>;
        reviews?: Record<string, { prompt?: string }> }>;
    };
    const referenced = Object.values(workflow.stages).flatMap((stage) => [
      ...Object.values(stage.workers).flatMap((worker) => Object.values(worker.prompts ?? {})),
      ...Object.values(stage.reviews ?? {}).flatMap((review) => review.prompt ? [review.prompt] : []),
    ]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const path of referenced)
      expect(() => readFileSync(resolve(root, "workflow-config/prompts", path))).not.toThrow();
  });
}

test("development publishes reviewed analysis, then updates the specification for planning and briefs", () => {
  interface DevelopmentSpecFlow {
    readonly run: { readonly units: { readonly planning: { readonly input: { readonly spec: string } };
      readonly briefs: { readonly input: { readonly spec: string } } } };
    readonly stages: { readonly analysis: { readonly artifacts: { readonly analysis: { readonly schema: string }; readonly spec: { readonly schema: string } };
      readonly workers: { readonly author: { readonly creates: string[] }; readonly spec_editor: { readonly when: string; readonly creates: string[] } };
      readonly reviews: { readonly analysis_review: { readonly of: string }; readonly spec_review: { readonly of: string } };
      readonly done_when: string; readonly outcome: { readonly spec: string } } };
  }
  const workflow = YAML.parse(readFileSync(resolve(root, WORKFLOW_SOURCES.development), "utf8")) as DevelopmentSpecFlow;
  const analysis = workflow.stages.analysis;
  expect({ artifacts: analysis.artifacts, author: analysis.workers.author.creates,
    editor: { when: analysis.workers.spec_editor.when, creates: analysis.workers.spec_editor.creates },
    review: analysis.reviews.analysis_review.of, specReview: analysis.reviews.spec_review.of,
    done_when: analysis.done_when, outcome: analysis.outcome.spec,
    planning: workflow.run.units.planning.input.spec, brief: workflow.run.units.briefs.input.spec })
    .toEqual({ artifacts: { analysis: { schema: "analysis_body" }, spec: { schema: "text" } }, author: ["analysis"],
      editor: { when: "approved(analysis)", creates: ["spec"] }, review: "analysis", specReview: "spec",
      done_when: "approved(analysis) and approved(spec)", outcome: "latest(spec)",
      planning: "analysis.outcome.spec", brief: "analysis.outcome.spec" });
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
