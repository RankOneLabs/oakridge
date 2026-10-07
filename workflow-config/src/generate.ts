import { resolve } from "node:path";
import { buildDevelopment } from "./development";

const root = resolve(import.meta.dir, "..");
const variants = [
  { name: "development.json", independentSiblings: false },
  { name: "development-independent-siblings.json", independentSiblings: true },
] as const;
let drift = false;
for (const variant of variants) {
  const path = resolve(root, "definitions", variant.name);
  const bytes = JSON.stringify(buildDevelopment(variant), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (await Bun.file(path).text() !== bytes) { console.error(`Bundle drift: ${path}`); drift = true; }
  } else await Bun.write(path, bytes);
}
if (drift) process.exit(1);
