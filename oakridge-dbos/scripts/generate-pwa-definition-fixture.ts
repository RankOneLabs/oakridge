/**
 * Writes the PWA's development definition fixture: the definition projection
 * of the generated development workflow, exactly as GET /api/definitions
 * serves its bundle. `--check` fails when the fixture has drifted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Workflow } from "../src/core-client/core-types";
import { selectDefinitionBundle } from "../src/projections/definition-view";

const root = resolve(import.meta.dir, "../..");
const source = resolve(root, "workflow-core/fixtures/bundles/development.json");
const output = resolve(root, "kbbl/core/pwa/oakridge/__fixtures__/development-definition.json");

const workflow = JSON.parse(readFileSync(source, "utf8")) as Workflow;
const generated = `${JSON.stringify(selectDefinitionBundle(workflow, 1), null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated)
    throw new Error("development-definition.json has drifted; run bun oakridge-dbos/scripts/generate-pwa-definition-fixture.ts");
} else writeFileSync(output, generated);
