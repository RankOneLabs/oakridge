import { expect, test } from "bun:test";
import { oakridgeCatalogue } from "../src/producers/oakridge/catalogue";
import { selectRevision } from "../src/projection/extractor";
import { fixtureBody } from "./grading-fixture";

test("the plan catalogue addresses decisions by cohort and acceptance entries by path", async () => {
  const definitions = oakridgeCatalogue("plan", "development-v1");
  expect(definitions.every((definition) => definition.schema_version === "development-v1" && definition.extractor_version === "1")).toBe(true);
  const pass = selectRevision(await fixtureBody("plan"), "plan-1", definitions);
  expect(pass.issues).toEqual([]);
  const entry = pass.items.find(({ item }) => item.item_kind === "acceptance_entry")?.item;
  expect(entry).toMatchObject({ item_id_or_path: "/cohorts/0/acceptance_criteria/0", item_scope: "task", producer_local_id: "T7" });
  const decision = pass.items.find(({ item }) => item.item_kind === "decision")?.item;
  expect(decision?.item_scope).toBe("cohort/alpha/decision");
  expect(pass.items.map(({ item }) => item.item_kind)).not.toContain("plan_wide_criterion");
});

test("the catalogue only emits stated links and never derives a split", async () => {
  for (const name of ["analysis", "tasks", "plan", "brief", "assessment"]) {
    const pass = selectRevision(await fixtureBody(name), `${name}-1`, oakridgeCatalogue(name, "development-v1"));
    expect(pass.items.flatMap(({ item }) => item.links).some((link) => link.type === "split_from")).toBe(false);
  }
  const brief = selectRevision(await fixtureBody("brief"), "brief-1", oakridgeCatalogue("brief", "development-v1"));
  const entry = brief.items.find(({ item }) => item.item_kind === "acceptance_entry")?.item;
  expect(entry?.links).toEqual([]);
  expect(oakridgeCatalogue("spec", "development-v1")).toEqual([]);
});

test("a finding keeps its producer id without using it as its address", async () => {
  const pass = selectRevision(await fixtureBody("analysis"), "analysis-1", oakridgeCatalogue("analysis", "v1"));
  const finding = pass.items.find(({ item }) => item.item_kind === "finding")?.item;
  expect(finding).toMatchObject({ item_id_or_path: "/findings/0", item_scope: null, producer_local_id: "finding-a" });
});

test("build items retain exact path and cohort identity with explicit task and decision links", () => {
  const body = { cohort_id: "alpha", build_items: [{ id: "B1", description: "Implement it", task_ids: ["T1", "T2"], decision_ids: ["D1"], verification: "test" }] };
  const definition = oakridgeCatalogue("brief", "v4").find((entry) => entry.extractor_id === "brief.build_items")!;
  const result = definition.select(body);
  expect(result).toMatchObject({ ok: true, value: [{ item_kind: "build_item", item_scope: "cohort/alpha/build_item", producer_local_id: "B1", item_id_or_path: "/build_items/0", path: "/build_items/0", links: [
    { type: "addresses", target: "logical_item", target_local_id: "T1" }, { type: "addresses", target_local_id: "T2" }, { type: "derived_from", target_local_id: "D1" }
  ] }] });
  expect(definition.select({ cohort_id: "alpha", acceptance_criteria: [] })).toEqual({ ok: true, value: [] });
  const legacy = oakridgeCatalogue("brief", "v4").find((entry) => entry.extractor_id === "brief.acceptance_entries")!;
  expect(legacy.select(body)).toEqual({ ok: true, value: [] });
});

test("finding shapes keep their original paths and never reinterpret each other", () => {
  const body: import("../src/domain/primitives").JsonValue = { findings: [{ task_ids: ["T1"], evidence: [] }, { subjects: [{ kind: "build_item", id: "B1", cohort_id: "alpha" }, { kind: "task", id: "T2" }], evidence: [] }] };
  const pass = selectRevision(body, "assessment", oakridgeCatalogue("assessment", "v4"));
  expect(pass.items.map(({ item }) => [item.path, item.links.map((link) => [link.type, link.target, link.target_local_id])]).sort()).toEqual([
    ["/findings/0", [["assesses", "logical_item", "T1"]]],
    ["/findings/1", [["assesses", "occurrence", "B1"], ["assesses", "logical_item", "T2"]]],
  ]);
  expect(pass.issues).toEqual([]);
});
