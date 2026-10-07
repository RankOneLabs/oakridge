import { readFileSync } from "node:fs";
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
