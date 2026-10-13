import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { WORKFLOW_SOURCES } from "./workflow-sources";

const root = resolve(import.meta.dir, "../..");
const isCheck = process.argv.includes("--check");

for (const [name, path] of Object.entries(WORKFLOW_SOURCES)) {
  const source = resolve(root, path);
  const document = YAML.parseDocument(readFileSync(source, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${source}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const fixture = JSON.stringify(document.toJS(), null, 2) + "\n";
  const output = resolve(root, "workflow-core/fixtures/bundles", `${name}.json`);
  if (isCheck) {
    if (readFileSync(output, "utf8") !== fixture) {
      throw new Error(`${output} differs from ${source}; run bun workflow-config/src/generate.ts`);
    }
  } else {
    await Bun.write(output, fixture);
  }
}
