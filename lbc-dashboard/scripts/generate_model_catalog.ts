#!/usr/bin/env bun
/**
 * Mirror kbbl/core/model-catalog.ts into lbc-dashboard/src/generated/model_catalog.ts.
 *
 * Run from the repo root:
 *   bun run lbc-dashboard/scripts/generate_model_catalog.ts
 *
 * CI drift check: regenerate then `git diff --exit-code`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SOURCE = join(REPO_ROOT, "kbbl", "core", "model-catalog.ts");
const OUTPUT = join(REPO_ROOT, "lbc-dashboard", "src", "generated", "model_catalog.ts");

const source = await readFile(SOURCE, "utf-8");

// Strip the doc comment and replace it with the generated-file header.
const withoutLeadingJsDoc = source.replace(/^\/\*\*[\s\S]*?\*\/\n/, "");

const generated =
  "// AUTO-GENERATED — do not edit.\n" +
  "// Source: kbbl/core/model-catalog.ts\n" +
  "// Regenerate: bun run lbc-dashboard/scripts/generate_model_catalog.ts\n" +
  "// CI drift: regenerate then `git diff --exit-code lbc-dashboard/src/generated/model_catalog.ts`.\n" +
  withoutLeadingJsDoc;

await writeFile(OUTPUT, generated, "utf-8");
console.log(`wrote ${OUTPUT.replace(REPO_ROOT + "/", "")}`);
