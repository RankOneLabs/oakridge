import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("live operator shapes are explicitly extracted from DBOS projections", () => {
  const generator = read("kbbl/scripts/generate-operator-contracts.ts");
  const projections = ["scope-view.ts", "inbox.ts"].map((file) => read(`oakridge-dbos/src/projections/${file}`)).join("\n");
  for (const name of ["OperatorCheckedValue", "OperatorScopeView", "OperatorInbox", "OperatorSchema", "OperatorCommandDescriptor", "OperatorTargetRevision"]) {
    expect(projections).toContain(`export interface ${name}`);
    expect(generator).toContain(`"${name}"`);
  }
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
