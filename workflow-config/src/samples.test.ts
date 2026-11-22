import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { expandIncludes } from "./workflow-include";
import { discoverWorkflowSources } from "./workflow-sources";
import { listPromptCatalog } from "./prompt-catalog";

const root = resolve(import.meta.dir, "../..");
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

// The Rust compiler and replay tests read the JSON; the YAML is what a person
// edits. These assertions are what generate.ts --check enforces in CI.
for (const { name, path } of discoverWorkflowSources(root)) {
  const document = expandIncludes(YAML.parseDocument(readFileSync(resolve(root, path), "utf8")),
    (include) => YAML.parseDocument(readFileSync(resolve(root, "workflow-config", include), "utf8")));
  if (!document.ok) throw new Error(document.error.detail);
  test(`${name}.json is the committed derivation of ${path}`, () => {
    expect(document.value.errors).toEqual([]);
    const fixture = readFileSync(resolve(root, "workflow-core/fixtures/bundles", `${name}.json`), "utf8");
    expect(fixture).toBe(`${JSON.stringify(document.value.toJS(), null, 2)}\n`);
  });

  test(`${path} names only prompt files that exist`, () => {
    const workflow = document.value.toJS() as {
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
