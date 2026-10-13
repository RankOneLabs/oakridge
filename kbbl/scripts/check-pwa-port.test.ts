import { expect, test } from "bun:test";
import { checkPort, testIds, v1Vocabulary } from "./check-pwa-port";

test("the v1 contract's names are flagged, and body fields and test ids that share a word are not", () => {
  expect(v1Vocabulary([
    "const id = unit.scope_id;", "import type { OperatorScopeView } from './c';", "item.kind === \"command\" ? item.consequence : null",
    "post(`/api/runs/${id}/scopes/${unit}`)", "selectFieldItems(cohort, \"files_in_scope\")", "<form data-testid=\"operator-command-form\">",
  ].join("\n")).map((hit) => hit.split(":")[0])).toEqual(["1", "2", "3", "4"]);
});

test("test ids are read from both attribute forms", () => {
  expect(testIds('<p data-testid="or-a" /><Chip testId="or-b" /><li data-testid={`or-c-${n}`} />')).toEqual(["or-a", "or-b", "or-c-${n}"]);
});

test("the PWA keeps its baseline test ids and stylesheet and reads only the v2 contract", () => {
  expect(checkPort()).toEqual([]);
});
