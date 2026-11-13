import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const CONTRACTS = "kbbl/core/pwa/oakridge/grading-contracts";
const contracts = () => readdirSync(resolve(root, CONTRACTS), { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, source: read(`${CONTRACTS}/${file}`) }));

test("every grading API export is generated in exactly one contract file", () => {
  const api = read("observation/src/http/grading-api.ts");
  const exported = [...api.matchAll(/export type \{([^}]+)\}/g)].flatMap((match) => match[1]!.split(",").map((name) => name.trim()));
  expect(exported.length).toBeGreaterThan(0);
  for (const name of exported) {
    const declaring = contracts().filter(({ source }) => new RegExp(`export (interface|type) Observation${name}\\b`).test(source));
    expect({ name, files: declaring.map(({ file }) => file) }).toEqual({ name, files: [expect.any(String)] });
  }
});

test("the browser publish request exposes only HTTP publication preconditions", () => {
  const source = ts.createSourceFile("grading-config.ts", read(`${CONTRACTS}/http/grading-config.ts`), ts.ScriptTarget.Latest, true);
  const request = source.statements.find((node): node is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(node) && node.name.text === "ObservationPublishRequest");
  expect(request?.members.map((member) => member.name?.getText(source))).toEqual(["expected_draft_digest", "expected_latest_version"]);
});

test("generated grading contracts import only each other, and only as types", () => {
  const files = new Set(contracts().map(({ file }) => file));
  for (const { file, source } of contracts()) {
    for (const line of source.match(/^(import|export .* from) .*$/gm) ?? []) {
      const sibling = /^import type \{ [^}]+ \} from "(\.\.?\/[^"]+)";$/.exec(line);
      expect(sibling, `${file}: ${line}`).not.toBeNull();
      expect(files.has(join(dirname(file), `${sibling![1]}.ts`)), `${file}: ${line}`).toBe(true);
    }
  }
});

test("ids keep their brands, so the PWA cannot pass one identity for another", () => {
  const identity = read(`${CONTRACTS}/domain/identity.ts`);
  for (const name of ["ItemOccurrenceId", "ArtifactRevisionId", "UnitId", "LogicalItemId", "RelationId", "EvidenceSetId", "GradeObservationId", "ReviewerId"])
    expect(identity).toMatch(new RegExp(`export type Observation${name} = ObservationBrand<string, "Observation${name}">;`));
});

test("the PWA declares no hand-written observation wire types", () => {
  const types = read("kbbl/core/pwa/oakridge/grading-types.ts");
  expect(types).not.toMatch(/export (interface|type) (Paged|AnswerRead|ItemStatus|TaskComposite|DrilldownKey|EvidenceRead|AnswerSubmission)\b/);
});
