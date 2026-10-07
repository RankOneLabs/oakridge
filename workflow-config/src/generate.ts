import { resolve } from "node:path";
import { buildDevelopmentRun } from "./development";
import { DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY } from "./development/policies";

const root = resolve(import.meta.dir, "..");
const variants = [DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY];
let drift = false;
for (const variant of variants) {
  const path = resolve(root, "definitions", `${variant.key}.json`);
  const bytes = JSON.stringify(buildDevelopmentRun(variant), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (await Bun.file(path).text() !== bytes) { console.error(`Bundle drift: ${path}`); drift = true; }
  } else await Bun.write(path, bytes);
}
if (drift) process.exit(1);
