import { expect, test } from "bun:test";
import type { JsonValue } from "../src/domain/primitives";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";

async function fixture(name: string): Promise<JsonValue> {
  return await Bun.file(new URL(`../fixtures/oakridge/${name}-revision.json`, import.meta.url)).json() as JsonValue;
}

test("the pinned plan catalogue addresses cohort ids and plan-wide paths honestly", async () => {
  const definitions = oakridgeDevelopmentCatalogue("plan", "development-v1");
  expect(definitions.every((definition) => definition.schema_version === "development-v1" && definition.extractor_version === "1")).toBe(true);
  const pass = selectRevision(await fixture("plan"), "plan-1", definitions);
  expect(pass.issues).toEqual([]);
  const criterion = pass.items.find(({ item }) => item.item_kind === "criterion")?.item;
  expect(criterion?.item_scope).toBe("cohort/alpha/criterion");
  expect(criterion?.producer_local_id).toBe("crit-a");
  const planWide = pass.items.find(({ item }) => item.item_kind === "plan_wide_criterion")?.item;
  expect(planWide?.item_id_or_path).toBe("/acceptance_criteria/0");
  expect(planWide?.item_scope).toBeNull();
  expect(planWide?.links).toEqual([]);
});

test("the catalogue only emits stated links and never derives a split", async () => {
  for (const name of ["analysis", "plan", "brief", "assessment"]) {
    const pass = selectRevision(await fixture(name), `${name}-1`, oakridgeDevelopmentCatalogue(name, "development-v1"));
    expect(pass.items.flatMap(({ item }) => item.links).some((link) => link.type === "split_from")).toBe(false);
  }
  const brief = selectRevision(await fixture("brief"), "brief-1", oakridgeDevelopmentCatalogue("brief", "development-v1"));
  const criterion = brief.items.find(({ item }) => item.item_kind === "criterion")?.item;
  expect(criterion?.links).toMatchObject([{ target_artifact_kind: "plan", target_local_id: "crit-a", if_present: true }]);
  expect(oakridgeDevelopmentCatalogue("spec", "development-v1")).toEqual([]);
});
