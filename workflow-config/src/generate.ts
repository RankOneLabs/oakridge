import { resolve } from "node:path";
import { buildDevelopmentRun } from "./development";
import { renderPromptFiles } from "./development/prompts";
import { DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, VERIFICATION_POLICY } from "./development/policies";

const root = resolve(import.meta.dir, "..");
const variants = [DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, VERIFICATION_POLICY];
const check = process.argv.includes("--check");
const promptDrift = renderPromptFiles(check);
for (const path of promptDrift) console.error(`Prompt drift: ${path}`);
if (promptDrift.length > 0) process.exit(1);
// Bundles are not committed; every consumer generates them first.
for (const variant of variants)
  await Bun.write(resolve(root, "definitions", `${variant.key}.json`), JSON.stringify(buildDevelopmentRun(variant), null, 2) + "\n");
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
