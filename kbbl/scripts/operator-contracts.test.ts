import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const CONTRACTS = "kbbl/core/pwa/oakridge/operator-contracts";
const contracts = () => readdirSync(resolve(root, CONTRACTS), { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, source: read(`${CONTRACTS}/${file}`) }));

test("every operator API export is generated in exactly one contract file", () => {
  const api = read("oakridge-dbos/src/http/operator-api.ts");
  const exported = [...api.matchAll(/export type \{([^}]+)\}/g)].flatMap((match) => match[1]!.split(",").map((name) => name.trim()));
  expect(exported.length).toBeGreaterThan(0);
  for (const name of exported) {
    const declaring = contracts().filter(({ source }) => new RegExp(`export (interface|type) Operator${name}\\b`).test(source));
    expect(declaring.map(({ file }) => file)).toHaveLength(1);
  }
});

test("generated contracts import only each other, and only as types", () => {
  const files = new Set(contracts().map(({ file }) => file));
  for (const { file, source } of contracts()) {
    for (const line of source.match(/^(import|export .* from) .*$/gm) ?? []) {
      const sibling = /^import type \{ [^}]+ \} from "(\.\.?\/[^"]+)";$/.exec(line);
      expect(sibling, `${file}: ${line}`).not.toBeNull();
      expect(files.has(join(dirname(file), `${sibling![1]}.ts`)), `${file}: ${line}`).toBe(true);
    }
  }
});

test("the backend declares no hand-mirrored operator wire types", () => {
  const projections = ["run-view.ts", "definition-view.ts", "collaboration-view.ts", "run-event.ts"]
    .map((file) => read(`oakridge-dbos/src/projections/${file}`)).join("\n");
  expect(projections).not.toMatch(/export (interface|type) Operator/);
});

test("operator contracts have no handwritten base dependency", () => {
  for (const { source } of contracts()) expect(source).not.toContain("operator-contracts.base");
});

test("PWA sources and tests do not import a bundled workflow definition", () => {
  const directory = resolve(root, "kbbl/core/pwa");
  const files = readdirSync(directory, { recursive: true }).filter((entry): entry is string => typeof entry === "string"
    && /\.(ts|tsx)$/.test(entry) && !entry.includes("node_modules"));
  for (const file of files) {
    const source = readFileSync(resolve(directory, file), "utf8");
    expect(source).not.toMatch(/\b(?:import|export)\s+(?:[^;]*?\sfrom\s+)?["'][^"']*workflow-config\/definitions\//);
  }
});
