import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const root = resolve(import.meta.dir, "../..");
const isCheck = process.argv.includes("--check");

for (const name of ["review-loop", "fan-out"] as const) {
  const source = resolve(root, "workflow-config/samples", `${name}.yaml`);
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

// The operator PWA still uses the pinned v1 definition as test data during the
// DBOS cutover. Produce those local test fixtures only when that suite asks.
if (process.argv.includes("--pwa-fixtures")) {
  const { buildBundle } = await import("./build-bundle");
  const { renderPromptFiles } = await import("./development/prompts");
  const { DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, VERIFICATION_POLICY } = await import("./development/policies");
  for (const path of renderPromptFiles(false)) throw new Error(`Prompt drift: ${path}`);
  for (const variant of [DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, VERIFICATION_POLICY]) {
    const result = buildBundle({ authoring_version: 1, template: "development", key: variant.key,
      implementation_capacity: variant.implementation_capacity, sibling_failure: variant.sibling_failure,
      wire_field_order: variant.contract_field_order, stage_layout: variant.stage_layout ?? "standard" });
    if (!result.ok) throw new Error(`${result.error.field_path}: ${result.error.detail}`);
    await Bun.write(resolve(root, "workflow-config/definitions", `${variant.key}.json`), JSON.stringify(result.value, null, 2) + "\n");
  }
}
