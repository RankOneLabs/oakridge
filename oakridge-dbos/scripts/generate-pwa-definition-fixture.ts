/**
 * Writes the PWA's development definition fixture: the definition projection
 * of the generated development workflow, exactly as GET /api/definitions
 * serves its bundle. `--check` fails when the fixture has drifted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Workflow } from "../src/core-client/core-types";
import { compileWorkflow, CoreClient } from "../src/core-client/client";
import { selectDefinitionBundle } from "../src/projections/definition-view";
import { readWorkflowPrompts } from "../src/runtime/prompt-files";

const root = resolve(import.meta.dir, "../..");
const source = resolve(root, "workflow-core/fixtures/bundles/development.json");
const output = resolve(root, "kbbl/core/pwa/oakridge/__fixtures__/development-definition.json");

const workflow = JSON.parse(readFileSync(source, "utf8")) as Workflow;
const prompts = readWorkflowPrompts(workflow);
if (!prompts.ok) throw new Error(prompts.error.detail);
const started = CoreClient.start();
if (!started.ok) throw new Error(started.error.detail.detail);
let generated: string;
try {
  const compiled = await compileWorkflow(started.value, { workflow,
    prompts: Object.fromEntries(Object.entries(prompts.value).map(([path, prompt]) => [path, prompt.content])) });
  if (!compiled.ok) throw new Error(compiled.error.detail);
  generated = `${JSON.stringify(selectDefinitionBundle(compiled.value.workflow, workflow), null, 2)}\n`;
} finally { started.value.close(); }

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated)
    throw new Error("development-definition.json has drifted; run bun oakridge-dbos/scripts/generate-pwa-definition-fixture.ts");
} else writeFileSync(output, generated);
