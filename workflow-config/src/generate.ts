import { resolve } from "node:path";
import { buildBundle } from "./build-bundle";
import { renderPromptFiles } from "./development/prompts";
import { DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, VERIFICATION_POLICY } from "./development/policies";

const root = resolve(import.meta.dir, "..");
const variants = [DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, VERIFICATION_POLICY];
const check = process.argv.includes("--check");
const promptDrift = renderPromptFiles(check);
for (const path of promptDrift) console.error(`Prompt drift: ${path}`);
if (promptDrift.length > 0) process.exit(1);
// The checked-in bundles are byte-for-byte fixtures for every authoring change.
for (const variant of variants) {
  const result = buildBundle({ authoring_version: 1, template: "development", key: variant.key,
    implementation_capacity: variant.implementation_capacity, sibling_failure: variant.sibling_failure,
    wire_field_order: variant.contract_field_order, stage_layout: variant.stage_layout ?? "standard" });
  if (!result.ok) throw new Error(`${result.error.field_path}: ${result.error.detail}`);
  const path = resolve(root, "definitions", `${variant.key}.json`);
  const bytes = JSON.stringify(result.value, null, 2) + "\n";
  if (check) {
    if (await Bun.file(path).text() !== bytes) throw new Error(`Bundle drift: ${path}`);
  } else await Bun.write(path, bytes);
}
if (check) {
  const stageTests = Bun.spawnSync({
    cmd: ["bun", "test", "workflow-config/src/development/policies.test.ts"],
    cwd: resolve(root, ".."),
    stdout: "inherit", stderr: "inherit"
  });
  if (stageTests.exitCode !== 0) process.exit(stageTests.exitCode || 1);
  const compiler = Bun.spawnSync({
    cmd: ["cargo", "test", "-p", "workflow-compiler", "--test", "shipped_definitions"],
    cwd: resolve(root, "../workflow-core"),
    stdout: "inherit", stderr: "inherit"
  });
  if (compiler.exitCode !== 0) process.exit(compiler.exitCode || 1);
}
