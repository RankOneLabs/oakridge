import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("every operator API export is generated, and the PWA contract imports nothing", () => {
  const api = read("oakridge-dbos/src/http/operator-api.ts");
  const generated = read("kbbl/core/pwa/oakridge/operator-contracts.ts");
  const exported = [...api.matchAll(/export type \{([^}]+)\}/g)].flatMap((match) => match[1]!.split(",").map((name) => name.trim()));
  expect(exported.length).toBeGreaterThan(0);
  for (const name of exported) expect(generated).toMatch(new RegExp(`export (interface|type) Operator${name}\\b`));
  expect(generated).not.toMatch(/^import /m);
});

test("the backend declares no hand-mirrored operator wire types", () => {
  const projections = ["scope-view.ts", "inbox.ts", "run-view.ts"].map((file) => read(`oakridge-dbos/src/projections/${file}`)).join("\n");
  expect(projections).not.toMatch(/export (interface|type) Operator/);
});

test("operator contracts have no handwritten base dependency", () => {
  const generated = read("kbbl/core/pwa/oakridge/operator-contracts.ts");
  expect(generated).not.toContain("operator-contracts.base");
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
