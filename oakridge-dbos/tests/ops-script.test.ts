import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("the package exposes the workflows ops command", () => {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { scripts: { ops?: string } };
  expect(pkg.scripts.ops).toBe("bun run src/ops.ts");
});
