import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

test("the generated catalog includes every extractor module in its directory", () => {
  const directory = resolve(import.meta.dir, "../src/producers/oakridge/extractors");
  const modules = readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.endsWith(".generated.ts"))
    .map((name) => name.slice(0, -3)).sort();
  const index = readFileSync(resolve(directory, "index.generated.ts"), "utf8");
  const imported = Array.from(index.matchAll(/^import \{ registrations as \w+ \} from "\.\/([^"]+)";$/gm), ([, name]) => name).sort();
  expect(imported).toEqual(modules);
  expect(imported).toContain("portability");
});
